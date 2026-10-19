// TPS and TTFT statistics over RequestRecord rows
// Pure.
//
// Eligible rows: purpose 'turn', stopReason stop|toolUse|length, output > 0,
// durationMs > 0. Missing duration/TTFT never counts as zero.

import Foundation

public struct SpeedStats: Sendable, Equatable {
    public var n: Int
    public var median: Double?
    public var p25: Double?
    public var p75: Double?
    public var mean: Double?
}

public struct ModelDailyPerformance: Sendable, Equatable {
    public var day: String
    public var decodeTpsMedian: Double?
    public var ttftMedian: Double?
    public var n: Int
}

public struct ModelPerformance: Sendable, Equatable {
    public var provider: String?
    public var model: String?
    public var requests: Int
    public var timedRequests: Int
    public var decodeTps: SpeedStats
    public var requestTps: SpeedStats
    public var ttftMs: SpeedStats
    public var daily: [ModelDailyPerformance]
}

public struct TierCount: Sendable, Equatable {
    public var serviceTier: String?
    public var requests: Int
}

public struct PerformanceSummary: Sendable, Equatable {
    public var models: [ModelPerformance]
    public var tiers: [TierCount]

    var fields: [JSONField] {
        return [
            JSONField("models", .array(models.map { $0.json })),
            JSONField("tiers", .array(tiers.map { $0.json })),
        ]
    }
}

extension SpeedStats: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("n", .jInt(n)),
            JSONField("median", .jNum(median)),
            JSONField("p25", .jNum(p25)),
            JSONField("p75", .jNum(p75)),
            JSONField("mean", .jNum(mean)),
        ])
    }

    public init(json: JSONValue) {
        self.init(n: json["n"].intValue ?? 0, median: json["median"].doubleValue, p25: json["p25"].doubleValue,
                  p75: json["p75"].doubleValue, mean: json["mean"].doubleValue)
    }
}

extension ModelDailyPerformance: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("day", .string(day)),
            JSONField("decodeTpsMedian", .jNum(decodeTpsMedian)),
            JSONField("ttftMedian", .jNum(ttftMedian)),
            JSONField("n", .jInt(n)),
        ])
    }

    public init(json: JSONValue) {
        self.init(day: json["day"].stringValue ?? "", decodeTpsMedian: json["decodeTpsMedian"].doubleValue,
                  ttftMedian: json["ttftMedian"].doubleValue, n: json["n"].intValue ?? 0)
    }
}

extension ModelPerformance: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("provider", .jStr(provider)),
            JSONField("model", .jStr(model)),
            JSONField("requests", .jInt(requests)),
            JSONField("timedRequests", .jInt(timedRequests)),
            JSONField("decodeTps", decodeTps.json),
            JSONField("requestTps", requestTps.json),
            JSONField("ttftMs", ttftMs.json),
            JSONField("daily", .array(daily.map { $0.json })),
        ])
    }

    public init(json: JSONValue) {
        self.init(
            provider: json["provider"].stringValue,
            model: json["model"].stringValue,
            requests: json["requests"].intValue ?? 0,
            timedRequests: json["timedRequests"].intValue ?? 0,
            decodeTps: SpeedStats(json: json["decodeTps"]),
            requestTps: SpeedStats(json: json["requestTps"]),
            ttftMs: SpeedStats(json: json["ttftMs"]),
            daily: (json["daily"].arrayValue ?? []).map { ModelDailyPerformance(json: $0) }
        )
    }
}

extension TierCount: JSONRepresentable {
    public var json: JSONValue {
        return .object([JSONField("serviceTier", .jStr(serviceTier)), JSONField("requests", .jInt(requests))])
    }

    public init(json: JSONValue) {
        self.init(serviceTier: json["serviceTier"].stringValue, requests: json["requests"].intValue ?? 0)
    }
}

extension PerformanceSummary: JSONRepresentable {
    public var json: JSONValue { return .object(fields) }

    public init(json: JSONValue) {
        self.init(models: (json["models"].arrayValue ?? []).map { ModelPerformance(json: $0) },
                  tiers: (json["tiers"].arrayValue ?? []).map { TierCount(json: $0) })
    }
}

extension SpeedStats: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension ModelDailyPerformance: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension ModelPerformance: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension TierCount: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension PerformanceSummary: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}

public enum PerformanceAnalysis {
    static let eligibleStops: Set<String> = ["stop", "toolUse", "length"]

    /// Linear-interpolation percentile (R-7) of an ascending-sorted array.
    public static func percentile(_ sorted: [Double], _ p: Double) -> Double? {
        let n = sorted.count
        if n == 0 { return nil }
        if n == 1 { return sorted[0] }
        let pos = Double(n - 1) * p
        let lo = Int(pos.rounded(.down))
        let hi = Int(pos.rounded(.up))
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - Double(lo))
    }

    public static func stats(_ values: [Double]) -> SpeedStats {
        let sorted = values.filter { $0.isFinite }.sorted()
        let n = sorted.count
        if n == 0 { return SpeedStats(n: 0, median: nil, p25: nil, p75: nil, mean: nil) }
        var sum: Double = 0
        for v in sorted { sum += v }
        return SpeedStats(n: n, median: percentile(sorted, 0.5), p25: percentile(sorted, 0.25),
                          p75: percentile(sorted, 0.75), mean: sum / Double(n))
    }

    static func isEligible(_ row: RequestRecord) -> Bool {
        guard row.purpose == "turn", let stop = row.stopReason, eligibleStops.contains(stop) else { return false }
        guard let output = row.output, output > 0 else { return false }
        guard let duration = row.durationMs, duration.isFinite, duration > 0 else { return false }
        return true
    }

    static func tierMatches(_ row: RequestRecord, _ filter: TierFilter) -> Bool {
        switch filter {
        case .all: return true
        case .unreported: return row.serviceTier == nil
        case .tier(let t): return row.serviceTier == t
        }
    }

    final class ModelAcc {
        let provider: String?
        let model: String?
        var requests = 0
        var timedRequests = 0
        var decode: [Double] = []
        var request: [Double] = []
        var ttft: [Double] = []
        var days: [String: DayAcc] = [:]

        init(provider: String?, model: String?) {
            self.provider = provider
            self.model = model
        }
    }

    final class DayAcc {
        var n = 0
        var decode: [Double] = []
        var ttft: [Double] = []
    }

    /// Throws `bad_tier` for a tier outside TIER_FILTERS, `invalid_ts` for an
    /// out-of-range timestamp.
    public static func summarize(_ rows: [RequestRecord], tzOffsetMinutes: Int = 0,
                                 serviceTier: TierFilter = .all) throws -> PerformanceSummary {
        if case .tier(let t) = serviceTier, TierFilter(name: t) == nil {
            throw TiboTattleError("bad_tier")
        }

        var tierOrder: [String?] = []
        var tierCounts: [String?: Int] = [:]
        var modelOrder: [String] = []
        var models: [String: ModelAcc] = [:]

        for row in rows {
            guard isEligible(row) else { continue }
            let tier = row.serviceTier
            if tierCounts[tier] == nil {
                tierOrder.append(tier)
                tierCounts[tier] = 0
            }
            tierCounts[tier] = (tierCounts[tier] ?? 0) + 1
            guard tierMatches(row, serviceTier) else { continue }

            let id = JSONValue.array([.jStr(row.provider), .jStr(row.model)]).serialized()
            let m: ModelAcc
            if let existing = models[id] {
                m = existing
            } else {
                m = ModelAcc(provider: row.provider, model: row.model)
                models[id] = m
                modelOrder.append(id)
            }

            let output = Double(row.output ?? 0)
            let duration = row.durationMs ?? 0
            let requestTps = output / (duration / 1000)
            var decodeTps: Double? = nil
            let ttft: Double? = (row.ttftMs?.isFinite ?? false) ? row.ttftMs : nil
            if let t = ttft, duration - t >= 100 {
                decodeTps = output / ((duration - t) / 1000)
            }

            m.requests += 1
            m.request.append(requestTps)
            if let t = ttft {
                m.timedRequests += 1
                m.ttft.append(t)
            }
            if let d = decodeTps { m.decode.append(d) }

            if row.ts.isFinite {
                let day = try Period.dayKey(row.ts, tzOffsetMinutes: tzOffsetMinutes)
                let d: DayAcc
                if let existing = m.days[day] {
                    d = existing
                } else {
                    d = DayAcc()
                    m.days[day] = d
                }
                d.n += 1
                if let v = decodeTps { d.decode.append(v) }
                if let t = ttft { d.ttft.append(t) }
            }
        }

        let outModels: [ModelPerformance] = modelOrder.map { id -> ModelPerformance in
            let m = models[id]!
            let dayKeys = m.days.keys.sorted { JSCompat.less($0, $1) }
            let daily: [ModelDailyPerformance] = dayKeys.map { day -> ModelDailyPerformance in
                let d = m.days[day]!
                return ModelDailyPerformance(day: day, decodeTpsMedian: stats(d.decode).median,
                                             ttftMedian: stats(d.ttft).median, n: d.n)
            }
            return ModelPerformance(provider: m.provider, model: m.model, requests: m.requests,
                                    timedRequests: m.timedRequests, decodeTps: stats(m.decode),
                                    requestTps: stats(m.request), ttftMs: stats(m.ttft), daily: daily)
        }
        let sortedModels = stableSorted(outModels) { a, b -> Int in
            if a.requests != b.requests { return b.requests > a.requests ? 1 : -1 }
            let p = JSCompat.compareNullable(a.provider, b.provider)
            if p != 0 { return p }
            return JSCompat.compareNullable(a.model, b.model)
        }

        let tierList: [TierCount] = tierOrder.map { TierCount(serviceTier: $0, requests: tierCounts[$0] ?? 0) }
        let sortedTiers = stableSorted(tierList) { a, b -> Int in
            if b.requests != a.requests { return b.requests > a.requests ? 1 : -1 }
            if a.serviceTier == nil { return 1 }
            if b.serviceTier == nil { return -1 }
            return JSCompat.compareNullable(a.serviceTier, b.serviceTier)
        }

        return PerformanceSummary(models: sortedModels, tiers: sortedTiers)
    }
}
