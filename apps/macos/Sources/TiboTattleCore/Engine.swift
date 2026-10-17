// Refresh orchestration and summaries (src/monitor.js plus the query side of
// src/server.js).
//
// - refresh() is single-flight: runs execute one at a time on an internal
//   serial queue, and callers that arrive while a run is in progress share one
//   follow-up run instead of queueing one each.
// - `generation` is a data version: it increments only when a refresh added
//   rows (requests or snapshots).
// - lastError is a fixed code string, never an error message.
// - Queries read the index directly (the store serializes access), so they
//   are not blocked behind a long scan.

import Foundation

public struct RefreshResult: Sendable, Equatable {
    public let generation: Int
    public let requestsAdded: Int
    public let snapshotsAdded: Int

    public init(generation: Int, requestsAdded: Int, snapshotsAdded: Int) {
        self.generation = generation
        self.requestsAdded = requestsAdded
        self.snapshotsAdded = snapshotsAdded
    }
}

public struct SourceRootStatus: Sendable, Equatable {
    /// "readable" or "missing".
    public var status: String
}

public struct EngineSourcesStatus: Sendable, Equatable {
    public var sessionRoots: [SourceRootStatus]
    /// "ok", "missing", "unavailable", or nil before the first import.
    public var agentDb: String?
}

public struct EngineStatus: Sendable, Equatable {
    public var generation: Int
    public var lastRefreshAt: Double?
    public var lastError: String?
    public var refreshing: Bool
    public var sources: EngineSourcesStatus
    public var counts: StoreCounts?
}

extension SourceRootStatus: JSONRepresentable {
    public var json: JSONValue { return .object([JSONField("status", .string(status))]) }
    public init(json: JSONValue) { self.init(status: json["status"].stringValue ?? "missing") }
}

extension EngineSourcesStatus: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("sessionRoots", .array(sessionRoots.map { $0.json })),
            JSONField("agentDb", .jStr(agentDb)),
        ])
    }

    public init(json: JSONValue) {
        self.init(sessionRoots: (json["sessionRoots"].arrayValue ?? []).map { SourceRootStatus(json: $0) },
                  agentDb: json["agentDb"].stringValue)
    }
}

extension EngineStatus: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("generation", .jInt(generation)),
            JSONField("lastRefreshAt", .jNum(lastRefreshAt)),
            JSONField("lastError", .jStr(lastError)),
            JSONField("refreshing", .bool(refreshing)),
            JSONField("sources", sources.json),
            JSONField("counts", counts.map { $0.json } ?? .null),
        ])
    }

    public init(json: JSONValue) {
        self.init(
            generation: json["generation"].intValue ?? 0,
            lastRefreshAt: json["lastRefreshAt"].doubleValue,
            lastError: json["lastError"].stringValue,
            refreshing: json["refreshing"].boolValue ?? false,
            sources: EngineSourcesStatus(json: json["sources"]),
            counts: json["counts"].isNull ? nil : StoreCounts(json: json["counts"])
        )
    }
}

extension SourceRootStatus: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension EngineSourcesStatus: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension EngineStatus: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}

public final class Engine: @unchecked Sendable {
    public let sources: OmpSources
    public let stateDirectory: URL

    let store: Store
    let key: Data
    private let sessionRootPaths: [String]
    private let agentDbPathStrings: [String]

    private let refreshQueue = DispatchQueue(label: "tibotattle.engine.refresh", qos: .utility)
    private let stateLock = NSLock()

    // Guarded by stateLock.
    private var generationValue = 0
    private var lastRefreshAt: Double? = nil
    private var lastError: String? = nil
    private var agentDbStatus: String? = nil
    private var refreshing = false
    private var labelMap: [String: String] = [:]
    private var requestedTicket = 0
    private var completedTicket = 0
    private var lastResult = RefreshResult(generation: 0, requestsAdded: 0, snapshotsAdded: 0)
    private var changeHandler: (@Sendable (Int) -> Void)? = nil

    /// Creates the state directory (0700), loads or creates identity.key and
    /// opens index.sqlite. Throws TiboTattleError `state_dir_unavailable`,
    /// `store_newer` or `store_unavailable`.
    public init(sources: OmpSources, stateDirectory: URL) throws {
        self.sources = sources
        self.sessionRootPaths = sources.sessionRoots.map { PathUtil.resolve($0.path) }
        self.agentDbPathStrings = sources.agentDbPaths.map { PathUtil.resolve($0.path) }
        let dir: URL
        let loadedKey: Data
        do {
            dir = try StatePaths.ensureDirectory(stateDirectory)
            loadedKey = try KeyFile.loadOrCreate(stateDirectory: dir)
        } catch {
            throw TiboTattleError("state_dir_unavailable")
        }
        self.stateDirectory = dir
        self.key = loadedKey
        self.store = try Store(path: PathUtil.join(PathUtil.resolve(dir.path), StatePaths.indexFileName))
    }

    deinit {
        store.close()
    }

    /// projectKey -> label, memory only.
    public var labels: [String: String] {
        stateLock.lock()
        defer { stateLock.unlock() }
        return labelMap
    }

    public var generation: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return generationValue
    }

    /// Called (on the refresh queue) after a refresh that added rows.
    public var onChange: (@Sendable (Int) -> Void)? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return changeHandler
        }
        set {
            stateLock.lock()
            changeHandler = newValue
            stateLock.unlock()
        }
    }

    /// Scans session files and imports quota snapshots. Blocks until a run
    /// that started after this call has finished; concurrent callers share
    /// one run. Never call from `onChange`. Errors are recorded in
    /// `status().lastError` as fixed codes; this method does not throw for them.
    @discardableResult
    public func refresh() throws -> RefreshResult {
        stateLock.lock()
        requestedTicket += 1
        let ticket = requestedTicket
        stateLock.unlock()

        return refreshQueue.sync { () -> RefreshResult in
            stateLock.lock()
            if completedTicket >= ticket {
                let result = lastResult
                stateLock.unlock()
                return result
            }
            let startTicket = requestedTicket
            refreshing = true
            let currentLabels = labelMap
            stateLock.unlock()

            let outcome = runOnce(labels: currentLabels)

            stateLock.lock()
            for (k, v) in outcome.labels { labelMap[k] = v }
            let added = outcome.requestsAdded + outcome.snapshotsAdded
            if added > 0 { generationValue += 1 }
            lastRefreshAt = (Date().timeIntervalSince1970 * 1000).rounded(.down)
            lastError = outcome.errorCode
            if let status = outcome.agentDbStatus { agentDbStatus = status }
            let result = RefreshResult(generation: generationValue, requestsAdded: outcome.requestsAdded,
                                       snapshotsAdded: outcome.snapshotsAdded)
            lastResult = result
            completedTicket = startTicket
            refreshing = false
            let handler = changeHandler
            stateLock.unlock()

            if added > 0, let handler = handler { handler(result.generation) }
            return result
        }
    }

    /// Runs refresh() on a background queue.
    public func refreshInBackground(completion: (@Sendable (RefreshResult?) -> Void)? = nil) {
        DispatchQueue.global(qos: .utility).async { [self] in
            let result = try? self.refresh()
            completion?(result)
        }
    }

    private struct Outcome {
        var requestsAdded = 0
        var snapshotsAdded = 0
        var errorCode: String? = nil
        var agentDbStatus: String? = nil
        var labels: [String: String] = [:]
    }

    private static func code(_ error: Error, fallback: String) -> String {
        if let e = error as? TiboTattleError {
            if e.code == "store_newer" { return "store_newer" }
            if e.code == "aborted" { return "aborted" }
        }
        return fallback
    }

    private func runOnce(labels: [String: String]) -> Outcome {
        var outcome = Outcome()
        var scanLabels = labels
        do {
            let res = try SessionScanner.scanSessions(store: store, key: key, sessionRoots: sessionRootPaths,
                                                      labels: &scanLabels)
            outcome.requestsAdded = res.requestsAdded
        } catch {
            outcome.errorCode = Engine.code(error, fallback: "scan_failed")
        }
        outcome.labels = scanLabels

        do {
            let q = try QuotaReader.importQuotaSnapshots(store: store, key: key, agentDbPaths: agentDbPathStrings)
            outcome.snapshotsAdded = q.added
            outcome.agentDbStatus = q.status
        } catch {
            outcome.agentDbStatus = "unavailable"
            if outcome.errorCode == nil { outcome.errorCode = Engine.code(error, fallback: "quota_failed") }
        }
        return outcome
    }

    static func rootStatus(_ path: String) -> String {
        var st = stat()
        guard stat(path, &st) == 0, Int(st.st_mode) & 0o170000 == 0o040000 else { return "missing" }
        return access(path, R_OK) == 0 ? "readable" : "missing"
    }

    public func status() -> EngineStatus {
        let counts = try? store.counts()
        stateLock.lock()
        let snapshot = (generationValue, lastRefreshAt, lastError, refreshing, agentDbStatus)
        stateLock.unlock()
        return EngineStatus(
            generation: snapshot.0,
            lastRefreshAt: snapshot.1,
            lastError: snapshot.2,
            refreshing: snapshot.3,
            sources: EngineSourcesStatus(sessionRoots: sessionRootPaths.map { SourceRootStatus(status: Engine.rootStatus($0)) },
                                         agentDb: snapshot.4),
            counts: counts
        )
    }

    // MARK: Summaries

    static func milliseconds(_ date: Date) -> Double {
        return (date.timeIntervalSince1970 * 1000).rounded(.down)
    }

    func rows(_ range: PeriodRange) throws -> [RequestRecord] {
        return try store.queryRequests(fromMs: range.fromMs, toMs: range.toMs)
    }

    func usage(range: PeriodRange, tzOffsetMinutes: Int) throws -> UsageSummary {
        return try UsageAnalysis.summarize(try rows(range), tzOffsetMinutes: tzOffsetMinutes, labels: labels)
    }

    func allowance(nowMs: Double) throws -> [AllowanceSeries] {
        let snaps = try store.querySnapshots(fromMs: nowMs - AllowanceAnalysis.historyWindowMs, toMs: nowMs + 1)
        return try AllowanceAnalysis.summarize(snaps, nowMs: nowMs)
    }

    public func usage(period: Period, tzOffsetMinutes: Int, now: Date) throws -> UsageSummary {
        return try usage(range: period.resolve(nowMs: Engine.milliseconds(now)), tzOffsetMinutes: tzOffsetMinutes)
    }

    public func performance(period: Period, tzOffsetMinutes: Int, tier: TierFilter, now: Date) throws -> PerformanceSummary {
        let range = period.resolve(nowMs: Engine.milliseconds(now))
        return try PerformanceAnalysis.summarize(try rows(range), tzOffsetMinutes: tzOffsetMinutes, serviceTier: tier)
    }

    /// Series from the last 30 days of snapshots.
    public func allowance(now: Date) throws -> [AllowanceSeries] {
        return try allowance(nowMs: Engine.milliseconds(now))
    }

    /// Closes the index. Further calls fail with `store_unavailable`.
    public func close() {
        store.close()
    }
}
