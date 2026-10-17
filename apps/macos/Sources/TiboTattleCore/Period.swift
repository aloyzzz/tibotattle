// Reporting periods and day bucketing (src/analysis/period.js). Pure.

import Foundation

public enum Period: String, CaseIterable, Sendable {
    case h24 = "24h", d7 = "7d", d30 = "30d", all

    static let hourMs: Double = 60 * 60 * 1000
    static let dayMs: Double = 24 * hourMs

    var spanMs: Double? {
        switch self {
        case .h24: return Period.dayMs
        case .d7: return 7 * Period.dayMs
        case .d30: return 30 * Period.dayMs
        case .all: return nil
        }
    }

    /// Half-open [fromMs, toMs); toMs = floor(nowMs) + 1 so a row stamped
    /// exactly at nowMs is included. 'all' starts at 0.
    public func resolve(nowMs: Double) -> PeriodRange {
        let now = nowMs.rounded(.down)
        let toMs = now + 1
        let fromMs: Double
        if let span = spanMs {
            fromMs = max(0, now - span)
        } else {
            fromMs = 0
        }
        return PeriodRange(name: rawValue, fromMs: fromMs, toMs: toMs)
    }

    /// 'YYYY-MM-DD' for `ts` in a zone `tzOffsetMinutes` east of UTC.
    /// Throws `invalid_ts` where JavaScript's toISOString would throw.
    public static func dayKey(_ ts: Double, tzOffsetMinutes: Int = 0) throws -> String {
        guard ts.isFinite, let key = JSCompat.isoDayPrefix(ts + Double(tzOffsetMinutes) * 60 * 1000) else {
            throw TiboTattleError("invalid_ts")
        }
        return key
    }
}

public struct PeriodRange: Sendable, Equatable {
    public var name: String
    public var fromMs: Double
    public var toMs: Double

    public init(name: String, fromMs: Double, toMs: Double) {
        self.name = name
        self.fromMs = fromMs
        self.toMs = toMs
    }
}

extension PeriodRange: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("name", .string(name)),
            JSONField("fromMs", .number(fromMs)),
            JSONField("toMs", .number(toMs)),
        ])
    }

    public init(json: JSONValue) {
        self.init(name: json["name"].stringValue ?? "", fromMs: json["fromMs"].doubleValue ?? 0,
                  toMs: json["toMs"].doubleValue ?? 0)
    }
}

extension PeriodRange: Codable {
    public init(from decoder: Decoder) throws {
        self.init(json: try JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

/// Service tier filter for performance statistics.
public enum TierFilter: Sendable, Equatable {
    case all, unreported, tier(String)

    /// TIER_FILTERS in src/analysis/performance.js.
    public static let names = ["all", "unreported", "auto", "default", "flex", "scale", "priority", "ultrafast"]

    /// nil for names outside TIER_FILTERS.
    public init?(name: String) {
        switch name {
        case "all": self = .all
        case "unreported": self = .unreported
        default:
            guard TierFilter.names.contains(name) else { return nil }
            self = .tier(name)
        }
    }

    public var name: String {
        switch self {
        case .all: return "all"
        case .unreported: return "unreported"
        case .tier(let t): return t
        }
    }
}

/// Order-preserving stable sort with a three-way comparator (Array#sort is
/// stable in JavaScript; Swift's sort is not guaranteed to be).
func stableSorted<T>(_ items: [T], by compare: (T, T) -> Int) -> [T] {
    let indexed = Array(items.enumerated())
    let sorted = indexed.sorted { a, b in
        let c = compare(a.element, b.element)
        if c != 0 { return c < 0 }
        return a.offset < b.offset
    }
    return sorted.map { $0.element }
}

func cmpSign(_ d: Double) -> Int {
    if d < 0 { return -1 }
    if d > 0 { return 1 }
    return 0
}
