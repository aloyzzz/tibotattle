// Current allowance per (provider, accountKey, limitId) series and a pace
// forecast. Pure.

import Foundation

public struct AllowancePace: Sendable, Equatable {
    public var ratePerHour: Double
    public var projectedExhaustAt: Double
    /// nil when the series reports no reset time.
    public var exhaustsBeforeReset: Bool?
    public var basisStartAt: Double
    public var basisPoints: Int
}

public struct AllowancePoint: Sendable, Equatable {
    public var t: Double
    public var used: Double
}

public struct AllowanceSeries: Sendable, Equatable {
    public var provider: String?
    public var accountKey: String?
    public var accountLabel: String
    public var limitId: String?
    public var label: String?
    public var windowLabel: String?
    public var usedFraction: Double?
    public var remainingFraction: Double?
    public var status: String?
    public var resetsAt: Double?
    public var recordedAt: Double
    public var ageMs: Double
    public var stale: Bool
    public var pace: AllowancePace?
    public var history: [AllowancePoint]
}

extension AllowancePace: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("ratePerHour", .number(ratePerHour)),
            JSONField("projectedExhaustAt", .number(projectedExhaustAt)),
            JSONField("exhaustsBeforeReset", .jBool(exhaustsBeforeReset)),
            JSONField("basisStartAt", .number(basisStartAt)),
            JSONField("basisPoints", .jInt(basisPoints)),
        ])
    }

    public init(json: JSONValue) {
        self.init(ratePerHour: json["ratePerHour"].doubleValue ?? 0,
                  projectedExhaustAt: json["projectedExhaustAt"].doubleValue ?? 0,
                  exhaustsBeforeReset: json["exhaustsBeforeReset"].boolValue,
                  basisStartAt: json["basisStartAt"].doubleValue ?? 0,
                  basisPoints: json["basisPoints"].intValue ?? 0)
    }
}

extension AllowancePoint: JSONRepresentable {
    public var json: JSONValue {
        return .object([JSONField("t", .number(t)), JSONField("used", .number(used))])
    }

    public init(json: JSONValue) {
        self.init(t: json["t"].doubleValue ?? 0, used: json["used"].doubleValue ?? 0)
    }
}

extension AllowanceSeries: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("provider", .jStr(provider)),
            JSONField("accountKey", .jStr(accountKey)),
            JSONField("accountLabel", .string(accountLabel)),
            JSONField("limitId", .jStr(limitId)),
            JSONField("label", .jStr(label)),
            JSONField("windowLabel", .jStr(windowLabel)),
            JSONField("usedFraction", .jNum(usedFraction)),
            JSONField("remainingFraction", .jNum(remainingFraction)),
            JSONField("status", .jStr(status)),
            JSONField("resetsAt", .jNum(resetsAt)),
            JSONField("recordedAt", .number(recordedAt)),
            JSONField("ageMs", .number(ageMs)),
            JSONField("stale", .bool(stale)),
            JSONField("pace", pace.map { $0.json } ?? .null),
            JSONField("history", .array(history.map { $0.json })),
        ])
    }

    public init(json: JSONValue) {
        self.init(
            provider: json["provider"].stringValue,
            accountKey: json["accountKey"].stringValue,
            accountLabel: json["accountLabel"].stringValue ?? "",
            limitId: json["limitId"].stringValue,
            label: json["label"].stringValue,
            windowLabel: json["windowLabel"].stringValue,
            usedFraction: json["usedFraction"].doubleValue,
            remainingFraction: json["remainingFraction"].doubleValue,
            status: json["status"].stringValue,
            resetsAt: json["resetsAt"].doubleValue,
            recordedAt: json["recordedAt"].doubleValue ?? 0,
            ageMs: json["ageMs"].doubleValue ?? 0,
            stale: json["stale"].boolValue ?? false,
            pace: json["pace"].isNull ? nil : AllowancePace(json: json["pace"]),
            history: (json["history"].arrayValue ?? []).map { AllowancePoint(json: $0) }
        )
    }
}

extension AllowancePace: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension AllowancePoint: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension AllowanceSeries: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}

public enum AllowanceAnalysis {
    static let hourMs: Double = 60 * 60 * 1000
    static let dayMs: Double = 24 * hourMs
    public static let resetDrop: Double = 0.05
    public static let resetsAtToleranceMs: Double = 60 * 1000
    public static let minPaceSpanMs: Double = 20 * 60 * 1000
    public static let historyWindowMs: Double = 30 * dayMs
    public static let historyMaxPoints = 400
    public static let defaultStaleAfterMs: Double = 30 * 60 * 1000

    /// Snapshot with a known recordedAt (others are ignored up front).
    struct Point {
        var snap: QuotaSnapshot
        var recordedAt: Double
    }

    static func isReset(_ prev: Point, _ cur: Point) -> Bool {
        if let p = prev.snap.usedFraction, let c = cur.snap.usedFraction, p.isFinite, c.isFinite, p - c > resetDrop {
            return true
        }
        if let p = prev.snap.resetsAt, let c = cur.snap.resetsAt, p.isFinite, c.isFinite,
           abs(c - p) > resetsAtToleranceMs {
            return true
        }
        return false
    }

    static func computePace(_ sorted: [Point], _ latest: Point) -> AllowancePace? {
        var start = 0
        if sorted.count > 1 {
            for i in 1..<sorted.count where isReset(sorted[i - 1], sorted[i]) {
                start = i
            }
        }
        let basis = sorted[start...].filter { $0.snap.usedFraction.map { $0.isFinite } ?? false }
        guard basis.count >= 2, let first = basis.first, let last = basis.last,
              let firstUsed = first.snap.usedFraction, let lastUsed = last.snap.usedFraction else { return nil }
        let spanMs = last.recordedAt - first.recordedAt
        if spanMs < minPaceSpanMs { return nil }
        let increase = lastUsed - firstUsed
        if !(increase > 0) { return nil }
        let ratePerHour = increase / (spanMs / hourMs)
        let remaining = 1 - lastUsed
        let projectedExhaustAt = remaining <= 0
            ? last.recordedAt
            : JSCompat.round(last.recordedAt + (remaining / ratePerHour) * hourMs)
        var resetsAt: Double? = nil
        if let r = latest.snap.resetsAt, r.isFinite { resetsAt = r }
        return AllowancePace(
            ratePerHour: ratePerHour,
            projectedExhaustAt: projectedExhaustAt,
            exhaustsBeforeReset: resetsAt.map { projectedExhaustAt < $0 },
            basisStartAt: first.recordedAt,
            basisPoints: basis.count
        )
    }

    static func buildHistory(_ sorted: [Point], _ nowMs: Double) -> [AllowancePoint] {
        let from = nowMs - historyWindowMs
        var points: [AllowancePoint] = []
        for p in sorted where p.recordedAt >= from && p.recordedAt <= nowMs {
            if let used = p.snap.usedFraction, used.isFinite {
                points.append(AllowancePoint(t: p.recordedAt, used: used))
            }
        }
        if points.count <= historyMaxPoints { return points }
        let t0 = points[0].t
        let span = points[points.count - 1].t - t0 + 1
        var buckets: [AllowancePoint?] = Array(repeating: nil, count: historyMaxPoints)
        let maxIndex = Double(historyMaxPoints - 1)
        for p in points {
            let raw = (((p.t - t0) / span) * Double(historyMaxPoints)).rounded(.down)
            let idx = Int(min(maxIndex, raw))
            if let cur = buckets[idx] {
                if p.used > cur.used { buckets[idx] = p }
            } else {
                buckets[idx] = p
            }
        }
        return buckets.compactMap { $0 }
    }

    /// Throws `bad_now` when nowMs is not finite.
    public static func summarize(_ snapshots: [QuotaSnapshot], nowMs: Double,
                                 staleAfterMs: Double = defaultStaleAfterMs) throws -> [AllowanceSeries] {
        guard nowMs.isFinite else { throw TiboTattleError("bad_now") }
        var order: [String] = []
        var groups: [String: [Point]] = [:]
        for s in snapshots {
            guard let recordedAt = s.recordedAt, recordedAt.isFinite else { continue }
            let id = JSONValue.array([.jStr(s.provider), .jStr(s.accountKey), .jStr(s.limitId)]).serialized()
            if groups[id] == nil {
                groups[id] = []
                order.append(id)
            }
            groups[id]!.append(Point(snap: s, recordedAt: recordedAt))
        }

        var series: [AllowanceSeries] = []
        for id in order {
            let group = groups[id] ?? []
            let sorted = stableSorted(group) { a, b -> Int in
                let d = cmpSign(a.recordedAt - b.recordedAt)
                if d != 0 { return d }
                return JSCompat.compareNullable(a.snap.snapshotKey, b.snap.snapshotKey)
            }
            guard let latest = sorted.last else { continue }
            var used: Double? = nil
            if let u = latest.snap.usedFraction, u.isFinite { used = u }
            let ageMs = nowMs - latest.recordedAt
            let stale = ageMs > staleAfterMs
            let accountKey = latest.snap.accountKey
            let accountLabel = "\(latest.snap.provider ?? "unknown") account \(JSCompat.utf16Prefix(accountKey ?? "", 6))"
            var resetsAt: Double? = nil
            if let r = latest.snap.resetsAt, r.isFinite { resetsAt = r }
            series.append(AllowanceSeries(
                provider: latest.snap.provider,
                accountKey: accountKey,
                accountLabel: accountLabel,
                limitId: latest.snap.limitId,
                label: latest.snap.label,
                windowLabel: latest.snap.windowLabel,
                usedFraction: used,
                remainingFraction: used.map { max(0, 1 - $0) },
                status: latest.snap.status,
                resetsAt: resetsAt,
                recordedAt: latest.recordedAt,
                ageMs: ageMs,
                stale: stale,
                pace: stale ? nil : computePace(sorted, latest),
                history: buildHistory(sorted, nowMs)
            ))
        }

        return stableSorted(series) { a, b -> Int in
            let c1 = JSCompat.compareNullable(a.provider, b.provider)
            if c1 != 0 { return c1 }
            let c2 = JSCompat.compare(a.accountLabel, b.accountLabel)
            if c2 != 0 { return c2 }
            let c3 = JSCompat.compareNullable(a.label, b.label)
            if c3 != 0 { return c3 }
            let c4 = JSCompat.compareNullable(a.limitId, b.limitId)
            if c4 != 0 { return c4 }
            return JSCompat.compareNullable(a.accountKey, b.accountKey)
        }
    }
}
