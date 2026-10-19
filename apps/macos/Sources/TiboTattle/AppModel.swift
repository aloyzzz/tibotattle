// Owns the engine, file watching and the published popover state.
//
// Threading: all engine calls (init, refresh, API routing) run on `workQueue`;
// published state is only mutated on the main actor. Errors surface as fixed
// codes, never as paths, input or error descriptions.

import AppKit
import Foundation
import ServiceManagement
import TiboTattleCore

/// Key shared by the popover's @AppStorage and the model.
enum Prefs {
    static let periodKey = "popover.period"
    static let defaultPeriod = "7d"

    static func period(_ defaults: UserDefaults = .standard) -> Period {
        Period(rawValue: defaults.string(forKey: periodKey) ?? defaultPeriod) ?? .d7
    }
}

/// Everything the popover needs from one load, decoded off the main thread.
struct PopoverSnapshot: Sendable {
    var overview: OverviewDTO?
    var overviewError: String?
    var status: StatusDTO?
    var loadedAt: Date
}

/// Engine calls that run on the background work queue. Nonisolated on purpose.
enum Loader {
    /// Minutes east of UTC, as the dashboard sends (`-getTimezoneOffset()`).
    static func tzOffsetMinutes(_ now: Date = Date()) -> Int {
        let minutes = TimeZone.current.secondsFromGMT(for: now) / 60
        return min(840, max(-840, minutes))
    }

    static func get<T: Decodable>(_ type: T.Type, path: String, query: [String: String],
                                  engine: Engine, now: Date) -> (value: T?, error: String?) {
        let response = APIRouter.handle(method: "GET", path: path, query: query,
                                        headers: ["Accept": "application/json"], engine: engine, now: now)
        let decoder = JSONDecoder()
        guard response.status == 200 else {
            let code = (try? decoder.decode(ErrorDTO.self, from: response.body))?.error ?? "http_\(response.status)"
            return (nil, sanitizedCode(code))
        }
        guard let value = try? decoder.decode(T.self, from: response.body) else {
            return (nil, "bad_response")
        }
        return (value, nil)
    }

    static func snapshot(engine: Engine, period: Period) -> PopoverSnapshot {
        let now = Date()
        let query = ["period": period.rawValue, "tz": String(tzOffsetMinutes(now))]
        let overview = get(OverviewDTO.self, path: "/api/overview", query: query, engine: engine, now: now)
        let status = get(StatusDTO.self, path: "/api/status", query: [:], engine: engine, now: now)
        return PopoverSnapshot(overview: overview.value, overviewError: overview.error, status: status.value, loadedAt: now)
    }

    /// Error codes are short words; anything else becomes "internal".
    static func sanitizedCode(_ code: String) -> String {
        let ok = !code.isEmpty && code.count <= 40 && code.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
        return ok ? code : "internal"
    }

    /// Maps an engine error to a fixed code without printing its description.
    static func engineErrorCode(_ error: Error) -> String {
        let text = String(describing: error).lowercased()
        if text.contains("store_newer") || text.contains("storenewer") { return "store_newer" }
        return "engine_unavailable"
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var overview: OverviewDTO?
    @Published private(set) var overviewError: String?
    @Published private(set) var status: StatusDTO?
    @Published private(set) var loadedAt: Date?
    /// Fixed message shown instead of the summaries when the engine cannot start.
    @Published private(set) var fatalMessage: String?
    @Published private(set) var isRefreshing = false
    /// True once the engine opened the index.
    @Published private(set) var isReady = false
    @Published private(set) var lastRefreshError: String?
    @Published private(set) var loginItemEnabled = false
    @Published private(set) var loginItemNote: String?

    private var engine: Engine?
    private var sources: OmpSources?
    private var watcher: SourceWatcher?
    private var timer: Timer?
    private var refreshPending = false
    /// Orders snapshot application: an older load never overwrites a newer one.
    private var loadSeq = 0
    private var appliedSeq = 0
    private var dashboard: DashboardWindowController?
    private let workQueue = DispatchQueue(label: "io.github.aloyzzz.tibotattle.work", qos: .utility)

    init() {
        updateLoginItemState()
        start()
    }

    // MARK: Derived state

    var allowance: [AllowanceDTO] { overview?.allowance ?? [] }
    var lowest: LowestAllowance? { LowestAllowance(allowance) }

    // MARK: Lifecycle

    private func start() {
        let environment = ProcessInfo.processInfo.environment
        workQueue.async {
            let sources = OmpSources.resolve(environment: environment)
            let stateDirectory = StatePaths.defaultDirectory(environment: environment)
            do {
                let engine = try Engine(sources: sources, stateDirectory: stateDirectory)
                Task { @MainActor [weak self] in self?.engineReady(engine, sources: sources) }
            } catch {
                let code = Loader.engineErrorCode(error)
                Task { @MainActor [weak self] in self?.engineFailed(code) }
            }
        }
    }

    private func engineReady(_ engine: Engine, sources: OmpSources) {
        self.engine = engine
        self.sources = sources
        isReady = true
        startWatching(sources)
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        timer?.tolerance = 5
        // Show what the index already holds, then scan for new rows (both run
        // in order on the serial work queue).
        reloadSummaries()
        refresh()
    }

    private func engineFailed(_ code: String) {
        switch code {
        case "store_newer":
            fatalMessage = "The index was written by a newer version of TiboTattle (store_newer). Update this app; the index was left unchanged."
        default:
            fatalMessage = "TiboTattle could not open its index (\(code))."
        }
    }

    private func startWatching(_ sources: OmpSources) {
        var seen = Set<String>()
        var paths: [URL] = []
        let candidates = sources.sessionRoots + sources.agentDbPaths.map { $0.deletingLastPathComponent() }
        for url in candidates {
            let key = url.standardizedFileURL.path
            if seen.insert(key).inserted { paths.append(url) }
        }
        guard !paths.isEmpty else { return }
        let watcher = SourceWatcher(paths: paths, latency: 1.0) { [weak self] in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        watcher.start()
        self.watcher = watcher
    }

    // MARK: Refresh and loading

    /// Re-scans omp's files (single-flight, coalesced) and reloads summaries.
    func refresh() {
        guard let engine = engine else { return }
        if isRefreshing {
            refreshPending = true
            return
        }
        isRefreshing = true
        let period = Prefs.period()
        loadSeq += 1
        let seq = loadSeq
        workQueue.async {
            var added = false
            var errorCode: String?
            do {
                let result = try engine.refresh()
                added = result.requestsAdded > 0 || result.snapshotsAdded > 0
            } catch {
                errorCode = Loader.engineErrorCode(error) == "store_newer" ? "store_newer" : "refresh_failed"
            }
            let snapshot = Loader.snapshot(engine: engine, period: period)
            let rowsAdded = added
            let failure = errorCode
            Task { @MainActor [weak self] in
                self?.refreshFinished(snapshot, seq: seq, added: rowsAdded, errorCode: failure)
            }
        }
    }

    private func refreshFinished(_ snapshot: PopoverSnapshot, seq: Int, added: Bool, errorCode: String?) {
        apply(snapshot, seq: seq)
        lastRefreshError = errorCode
        isRefreshing = false
        if added { dashboard?.notifyChange() }
        if refreshPending {
            refreshPending = false
            refresh()
        }
    }

    /// Reloads summaries without re-scanning (period change, popover shown,
    /// or after the dashboard ran its own refresh).
    func reloadSummaries() {
        guard let engine = engine else { return }
        let period = Prefs.period()
        loadSeq += 1
        let seq = loadSeq
        workQueue.async {
            let snapshot = Loader.snapshot(engine: engine, period: period)
            Task { @MainActor [weak self] in self?.apply(snapshot, seq: seq) }
        }
    }

    private func apply(_ snapshot: PopoverSnapshot, seq: Int) {
        guard seq > appliedSeq else { return }
        appliedSeq = seq
        overview = snapshot.overview
        overviewError = snapshot.overviewError
        status = snapshot.status
        loadedAt = snapshot.loadedAt
    }

    // MARK: Dashboard window

    func openDashboard() {
        guard let engine = engine else { return }
        NSApp.activate(ignoringOtherApps: true)
        if let existing = dashboard {
            existing.show()
            return
        }
        let controller = DashboardWindowController(
            engine: engine,
            webRoot: Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
            onRefreshed: { [weak self] in self?.reloadSummaries() },
            onClose: { [weak self] in self?.dashboardClosed() }
        )
        dashboard = controller
        controller.show()
    }

    private func dashboardClosed() {
        // Release after AppKit finishes delivering the close.
        Task { @MainActor [weak self] in self?.dashboard = nil }
    }


    // MARK: Start at login (SMAppService, macOS 13+)

    func updateLoginItemState() {
        let status = SMAppService.mainApp.status
        loginItemEnabled = status == .enabled
        switch status {
        case .enabled: loginItemNote = nil
        case .requiresApproval: loginItemNote = "Needs approval in System Settings › Login Items."
        case .notFound: loginItemNote = "Unavailable for this copy of the app."
        case .notRegistered: loginItemNote = nil
        @unknown default: loginItemNote = nil
        }
    }

    func setLoginItem(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            updateLoginItemState()
        } catch {
            updateLoginItemState()
            if SMAppService.mainApp.status == .requiresApproval {
                SMAppService.openSystemSettingsLoginItems()
            } else {
                loginItemNote = enabled ? "Could not turn on start at login." : "Could not turn off start at login."
            }
        }
    }

    func quit() {
        watcher?.stop()
        timer?.invalidate()
        NSApp.terminate(nil)
    }
}
