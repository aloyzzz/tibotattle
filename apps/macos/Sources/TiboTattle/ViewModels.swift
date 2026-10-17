// Small Decodable view models for the popover. They decode only the fields the
// popover shows, using the JSON keys of src/server.js and src/analysis/*.js,
// so the app target does not depend on TiboTattleCore's Swift summary types.
// Every value is optional: a missing or null value stays nil and is shown as
// "—" or "unpriced", never as 0.

import Foundation

struct PeriodDTO: Decodable, Sendable {
    var name: String?
    var fromMs: Double?
    var toMs: Double?
}

struct TotalsDTO: Decodable, Sendable {
    var requests: Double?
    var input: Double?
    var output: Double?
    var cacheRead: Double?
    var totalTokens: Double?
    var costUsd: Double?
    var pricedRequests: Double?
    var unpricedRequests: Double?
    var errorRequests: Double?
    var unknownTokenRequests: Double?
    var cacheHitRate: Double?
}

struct PaceDTO: Decodable, Sendable {
    var ratePerHour: Double?
    var projectedExhaustAt: Double?
    var exhaustsBeforeReset: Bool?
}

struct AllowanceDTO: Decodable, Sendable {
    var provider: String?
    var accountKey: String?
    var accountLabel: String?
    var limitId: String?
    var label: String?
    var windowLabel: String?
    var usedFraction: Double?
    var remainingFraction: Double?
    var status: String?
    var resetsAt: Double?
    var recordedAt: Double?
    var stale: Bool?
    var pace: PaceDTO?
}

struct StatsDTO: Decodable, Sendable {
    var n: Double?
    var median: Double?
}

struct ModelDTO: Decodable, Sendable {
    var provider: String?
    var model: String?
    var requests: Double?
    var decodeTps: StatsDTO?
    var ttftMs: StatsDTO?
}

/// `GET /api/overview` -> `{ period, totals, byProvider, allowance, topModels }`.
struct OverviewDTO: Decodable, Sendable {
    var period: PeriodDTO?
    var totals: TotalsDTO?
    var allowance: [AllowanceDTO]?
    var topModels: [ModelDTO]?
}

struct RootStatusDTO: Decodable, Sendable {
    var status: String?
}

struct SourcesDTO: Decodable, Sendable {
    var sessionRoots: [RootStatusDTO]?
    var agentDb: String?
}

struct CountsDTO: Decodable, Sendable {
    var requests: Double?
    var snapshots: Double?
    var files: Double?
}

/// `GET /api/status` -> `monitor.status()`.
struct StatusDTO: Decodable, Sendable {
    var generation: Double?
    var lastRefreshAt: Double?
    var lastError: String?
    var refreshing: Bool?
    var sources: SourcesDTO?
    var counts: CountsDTO?

    private enum CodingKeys: String, CodingKey {
        case generation, lastRefreshAt, lastError, refreshing, sources, counts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generation = try? c.decodeIfPresent(Double.self, forKey: .generation)
        // Node sends epoch milliseconds; tolerate an ISO string as app.js does.
        if let ms = try? c.decodeIfPresent(Double.self, forKey: .lastRefreshAt) {
            lastRefreshAt = ms
        } else if let text = try? c.decodeIfPresent(String.self, forKey: .lastRefreshAt) {
            lastRefreshAt = Format.parseISODate(text).map { $0.timeIntervalSince1970 * 1000 }
        } else {
            lastRefreshAt = nil
        }
        lastError = try? c.decodeIfPresent(String.self, forKey: .lastError)
        refreshing = try? c.decodeIfPresent(Bool.self, forKey: .refreshing)
        sources = try? c.decodeIfPresent(SourcesDTO.self, forKey: .sources)
        counts = try? c.decodeIfPresent(CountsDTO.self, forKey: .counts)
    }
}

/// `{ "error": "<code>" }` bodies.
struct ErrorDTO: Decodable, Sendable {
    var error: String?
}

// MARK: - Derived values

extension AllowanceDTO {
    /// Mirrors `seriesTitle` in apps/web/app.js.
    var title: String {
        let base = label ?? limitId ?? "Limit"
        if let window = windowLabel, window != base { return "\(base) · \(window)" }
        return base
    }

    var isStale: Bool { stale == true }

    enum Tone { case ok, warn, critical, unknown }

    /// Mirrors `meterTone` in apps/web/app.js.
    var tone: Tone {
        guard let used = usedFraction else { return .unknown }
        let remaining = remainingFraction ?? max(0, 1 - used)
        if used >= 1 || remaining < 0.1 { return .critical }
        if remaining < 0.25 || pace?.exhaustsBeforeReset == true { return .warn }
        return .ok
    }

    /// Mirrors `paceText` in apps/web/app.js. nil when there is no forecast.
    func paceLine(now: Date) -> (text: String, warn: Bool)? {
        guard let p = pace else { return nil }
        if let at = p.projectedExhaustAt {
            if p.exhaustsBeforeReset == true {
                return ("On pace to run out \(Format.when(ms: at, now: now)), before reset.", true)
            }
            if p.exhaustsBeforeReset == nil {
                return ("On pace to run out \(Format.when(ms: at, now: now)).", true)
            }
        }
        return ("On pace to last until reset.", false)
    }
}

/// The lowest remaining allowance among fresh series, or among all series
/// (marked stale) when none is fresh. Mirrors the Electron tray logic.
struct LowestAllowance: Sendable {
    var series: AllowanceDTO
    var remaining: Double
    var allStale: Bool

    init?(_ list: [AllowanceDTO]) {
        let known = list.filter { $0.remainingFraction != nil }
        let fresh = known.filter { !$0.isStale }
        let pool = fresh.isEmpty ? known : fresh
        guard var best = pool.first, var bestValue = best.remainingFraction else { return nil }
        for s in pool.dropFirst() {
            if let v = s.remainingFraction, v < bestValue {
                best = s
                bestValue = v
            }
        }
        series = best
        remaining = bestValue
        allStale = fresh.isEmpty
    }

    /// Menu bar text: `62%`, or `62%?` when every series is stale.
    var menuText: String {
        let pct = Int((remaining * 100).rounded())
        return "\(pct)%" + (allStale ? "?" : "")
    }

    var tooltip: String {
        let window = series.windowLabel ?? series.label ?? "limit"
        var text = "TiboTattle: \(window) \(Int((remaining * 100).rounded()))% remaining"
        if let account = series.accountLabel { text += " (\(account))" }
        if allStale { text += ", stale" }
        return text
    }
}

// MARK: - Formatting (ported from apps/web/app.js)

enum Format {
    static let dash = "—"

    private static func trimZero(_ text: String) -> String {
        guard text.contains(".") else { return text }
        var t = text
        while t.hasSuffix("0") { t.removeLast() }
        if t.hasSuffix(".") { t.removeLast() }
        return t
    }

    private static func fixed(_ v: Double, _ digits: Int) -> String {
        String(format: "%.\(digits)f", v)
    }

    static func int(_ n: Double?) -> String {
        guard let n = n, n.isFinite else { return dash }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        f.locale = Locale(identifier: "en_US")
        return f.string(from: NSNumber(value: n.rounded())) ?? dash
    }

    static func compact(_ n: Double?) -> String {
        guard let n = n, n.isFinite else { return dash }
        let units: [(Double, String)] = [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "k")]
        let absN = abs(n)
        for (i, unit) in units.enumerated() where absN >= unit.0 * 0.9995 {
            let v = n / unit.0
            if abs(v) >= 999.5 && i > 0 {
                let prev = units[i - 1]
                return trimZero(fixed(n / prev.0, 1)) + prev.1
            }
            let body = abs(v) >= 100 ? String(Int(v.rounded())) : trimZero(fixed(v, 1))
            return body + unit.1
        }
        return String(Int(n.rounded()))
    }

    static func usd(_ v: Double?) -> String {
        guard let v = v, v.isFinite else { return "unpriced" }
        if v == 0 { return "$0.00" }
        let a = abs(v)
        if a < 0.0001 { return "<$0.0001" }
        let maxDigits = a >= 1 ? 2 : (a >= 0.1 ? 3 : 4)
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = maxDigits
        return "$" + (f.string(from: NSNumber(value: v)) ?? fixed(v, 2))
    }

    static func pct(_ fraction: Double?, digits: Int? = nil) -> String {
        guard let fraction = fraction, fraction.isFinite else { return dash }
        let p = fraction * 100
        let d = digits ?? ((abs(p) < 10 && p != 0) ? 1 : 0)
        return trimZero(fixed(p, d)) + "%"
    }

    static func ms(_ value: Double?) -> String {
        guard let ms = value, ms.isFinite else { return dash }
        if ms < 1000 { return "\(Int(ms.rounded())) ms" }
        if ms < 60000 { return trimZero(fixed(ms / 1000, ms < 10000 ? 2 : 1)) + " s" }
        let m = Int(ms / 60000)
        let s = Int((ms.truncatingRemainder(dividingBy: 60000) / 1000).rounded())
        return "\(m)m \(s)s"
    }

    static func tps(_ value: Double?) -> String {
        guard let v = value, v.isFinite else { return dash }
        return v >= 100 ? String(Int(v.rounded())) : trimZero(fixed(v, 1))
    }

    static func duration(ms: Double) -> String {
        let minutes = Int((abs(ms) / 60000).rounded())
        if minutes < 1 { return "under a minute" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours)h \(minutes % 60)m" }
        return "\(hours / 24)d \(hours % 24)h"
    }

    static func countdown(to resetsAt: Double?, now: Date) -> String {
        guard let at = resetsAt, at.isFinite else { return "Reset time not reported" }
        let diff = at - now.timeIntervalSince1970 * 1000
        if diff <= 0 { return "Reset due now" }
        return "Resets in \(duration(ms: diff))"
    }

    static func ago(_ atMs: Double?, now: Date) -> String {
        guard let at = atMs, at.isFinite else { return dash }
        let diff = now.timeIntervalSince1970 * 1000 - at
        if diff < 60000 { return "just now" }
        return "\(duration(ms: diff)) ago"
    }

    /// "at 14:05 today", "Tue 14:05" or "Oct 21, 14:05".
    static func when(ms: Double, now: Date) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let cal = Calendar.current
        let f = DateFormatter()
        f.locale = Locale.current
        if cal.isDate(date, inSameDayAs: now) {
            f.setLocalizedDateFormatFromTemplate("jmm")
            return "at \(f.string(from: date)) today"
        }
        if abs(date.timeIntervalSince(now)) < 6 * 86400 {
            f.setLocalizedDateFormatFromTemplate("EEEjmm")
            return "on \(f.string(from: date))"
        }
        f.setLocalizedDateFormatFromTemplate("MMMdjmm")
        return "on \(f.string(from: date))"
    }

    static func parseISODate(_ text: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: text) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: text)
    }

    /// Mirrors `costText` in apps/web/app.js.
    static func cost(_ t: TotalsDTO?) -> String {
        guard let t = t, let requests = t.requests, requests > 0 else { return dash }
        guard let priced = t.pricedRequests, priced > 0, let cost = t.costUsd else { return "unpriced" }
        return usd(cost)
    }

    /// Mirrors `unpricedNote` in apps/web/app.js.
    static func unpricedNote(_ t: TotalsDTO?) -> String? {
        guard let t = t, let unpriced = t.unpricedRequests, unpriced > 0 else { return nil }
        guard let priced = t.pricedRequests, priced > 0 else { return "\(int(unpriced)) without a price" }
        return "+\(int(unpriced)) unpriced"
    }
}
