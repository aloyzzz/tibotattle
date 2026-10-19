// Token, cost and request aggregates over RequestRecord rows
// Pure.
//
// Missing evidence: a token bucket sums only rows where it is known and is
// null when no row knows it; costUsd sums priced rows only and is null when
// none is priced; cacheHitRate is null when its denominator is 0 or absent.
// Sums are kept as Double like JavaScript numbers.

import Foundation

public struct UsageTotals: Sendable, Equatable {
    public var requests: Int
    public var sessions: Int
    public var input: Int?
    public var output: Int?
    public var cacheRead: Int?
    public var cacheWrite: Int?
    public var totalTokens: Int?
    public var costUsd: Double?
    public var pricedRequests: Int
    public var unpricedRequests: Int
    public var errorRequests: Int
    public var unknownTokenRequests: Int
    public var cacheHitRate: Double?

    var fields: [JSONField] {
        return [
            JSONField("requests", .jInt(requests)),
            JSONField("sessions", .jInt(sessions)),
            JSONField("input", .jInt(input)),
            JSONField("output", .jInt(output)),
            JSONField("cacheRead", .jInt(cacheRead)),
            JSONField("cacheWrite", .jInt(cacheWrite)),
            JSONField("totalTokens", .jInt(totalTokens)),
            JSONField("costUsd", .jNum(costUsd)),
            JSONField("pricedRequests", .jInt(pricedRequests)),
            JSONField("unpricedRequests", .jInt(unpricedRequests)),
            JSONField("errorRequests", .jInt(errorRequests)),
            JSONField("unknownTokenRequests", .jInt(unknownTokenRequests)),
            JSONField("cacheHitRate", .jNum(cacheHitRate)),
        ]
    }
}

extension UsageTotals: JSONRepresentable {
    public var json: JSONValue { return .object(fields) }

    public init(json: JSONValue) {
        self.init(
            requests: json["requests"].intValue ?? 0,
            sessions: json["sessions"].intValue ?? 0,
            input: json["input"].intValue,
            output: json["output"].intValue,
            cacheRead: json["cacheRead"].intValue,
            cacheWrite: json["cacheWrite"].intValue,
            totalTokens: json["totalTokens"].intValue,
            costUsd: json["costUsd"].doubleValue,
            pricedRequests: json["pricedRequests"].intValue ?? 0,
            unpricedRequests: json["unpricedRequests"].intValue ?? 0,
            errorRequests: json["errorRequests"].intValue ?? 0,
            unknownTokenRequests: json["unknownTokenRequests"].intValue ?? 0,
            cacheHitRate: json["cacheHitRate"].doubleValue
        )
    }
}

public struct ProviderUsage: Sendable, Equatable {
    public var provider: String?
    public var totals: UsageTotals
}

public struct ModelUsage: Sendable, Equatable {
    public var provider: String?
    public var model: String?
    public var totals: UsageTotals
}

public struct CredentialUsage: Sendable, Equatable {
    public var provider: String?
    /// nil = "unattributed".
    public var credentialId: Int?
    public var totals: UsageTotals
}

public struct ProjectUsage: Sendable, Equatable {
    public var projectKey: String?
    /// From the in-memory labels map, or nil.
    public var label: String?
    public var totals: UsageTotals
}

public struct AgentTypeUsage: Sendable, Equatable {
    public var agentType: String?
    public var totals: UsageTotals
}

public struct ServiceTierUsage: Sendable, Equatable {
    public var serviceTier: String?
    public var totals: UsageTotals
}

public struct DailyUsage: Sendable, Equatable {
    public var day: String
    public var totals: UsageTotals
}

extension ProviderUsage: JSONRepresentable {
    public var json: JSONValue { return .object([JSONField("provider", .jStr(provider))] + totals.fields) }
    public init(json: JSONValue) {
        self.init(provider: json["provider"].stringValue, totals: UsageTotals(json: json))
    }
}

extension ModelUsage: JSONRepresentable {
    public var json: JSONValue {
        return .object([JSONField("provider", .jStr(provider)), JSONField("model", .jStr(model))] + totals.fields)
    }
    public init(json: JSONValue) {
        self.init(provider: json["provider"].stringValue, model: json["model"].stringValue, totals: UsageTotals(json: json))
    }
}

extension CredentialUsage: JSONRepresentable {
    public var json: JSONValue {
        return .object([JSONField("provider", .jStr(provider)), JSONField("credentialId", .jInt(credentialId))] + totals.fields)
    }
    public init(json: JSONValue) {
        self.init(provider: json["provider"].stringValue, credentialId: json["credentialId"].intValue,
                  totals: UsageTotals(json: json))
    }
}

extension ProjectUsage: JSONRepresentable {
    public var json: JSONValue {
        return .object([JSONField("projectKey", .jStr(projectKey)), JSONField("label", .jStr(label))] + totals.fields)
    }
    public init(json: JSONValue) {
        self.init(projectKey: json["projectKey"].stringValue, label: json["label"].stringValue,
                  totals: UsageTotals(json: json))
    }
}

extension AgentTypeUsage: JSONRepresentable {
    public var json: JSONValue { return .object([JSONField("agentType", .jStr(agentType))] + totals.fields) }
    public init(json: JSONValue) {
        self.init(agentType: json["agentType"].stringValue, totals: UsageTotals(json: json))
    }
}

extension ServiceTierUsage: JSONRepresentable {
    public var json: JSONValue { return .object([JSONField("serviceTier", .jStr(serviceTier))] + totals.fields) }
    public init(json: JSONValue) {
        self.init(serviceTier: json["serviceTier"].stringValue, totals: UsageTotals(json: json))
    }
}

extension DailyUsage: JSONRepresentable {
    public var json: JSONValue { return .object([JSONField("day", .string(day))] + totals.fields) }
    public init(json: JSONValue) {
        self.init(day: json["day"].stringValue ?? "", totals: UsageTotals(json: json))
    }
}

public struct UsageSummary: Sendable, Equatable {
    public var totals: UsageTotals
    public var byProvider: [ProviderUsage]
    public var byModel: [ModelUsage]
    public var byCredential: [CredentialUsage]
    public var byProject: [ProjectUsage]
    public var byAgentType: [AgentTypeUsage]
    public var byServiceTier: [ServiceTierUsage]
    public var daily: [DailyUsage]

    var fields: [JSONField] {
        return [
            JSONField("totals", totals.json),
            JSONField("byProvider", .array(byProvider.map { $0.json })),
            JSONField("byModel", .array(byModel.map { $0.json })),
            JSONField("byCredential", .array(byCredential.map { $0.json })),
            JSONField("byProject", .array(byProject.map { $0.json })),
            JSONField("byAgentType", .array(byAgentType.map { $0.json })),
            JSONField("byServiceTier", .array(byServiceTier.map { $0.json })),
            JSONField("daily", .array(daily.map { $0.json })),
        ]
    }
}

extension UsageSummary: JSONRepresentable {
    public var json: JSONValue { return .object(fields) }

    public init(json: JSONValue) {
        func list<T: JSONRepresentable>(_ key: String, _ type: T.Type) -> [T] {
            return (json[key].arrayValue ?? []).map { T(json: $0) }
        }
        self.init(
            totals: UsageTotals(json: json["totals"]),
            byProvider: list("byProvider", ProviderUsage.self),
            byModel: list("byModel", ModelUsage.self),
            byCredential: list("byCredential", CredentialUsage.self),
            byProject: list("byProject", ProjectUsage.self),
            byAgentType: list("byAgentType", AgentTypeUsage.self),
            byServiceTier: list("byServiceTier", ServiceTierUsage.self),
            daily: list("daily", DailyUsage.self)
        )
    }
}

// Codable bridges (explicit nulls via JSONValue).
extension UsageTotals: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension ProviderUsage: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension ModelUsage: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension CredentialUsage: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension ProjectUsage: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension AgentTypeUsage: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension ServiceTierUsage: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension DailyUsage: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}
extension UsageSummary: Codable {
    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
}

struct UsageAccumulator {
    var requests = 0
    var sessionSet = Set<String>()
    var input: Double? = nil
    var output: Double? = nil
    var cacheRead: Double? = nil
    var cacheWrite: Double? = nil
    var totalTokens: Double? = nil
    var costUsd: Double? = nil
    var pricedRequests = 0
    var unpricedRequests = 0
    var errorRequests = 0
    var unknownTokenRequests = 0
    var hitNum: Double = 0
    var hitDen: Double = 0

    private static func plus(_ acc: Double?, _ v: Int?) -> Double? {
        guard let v = v else { return acc }
        return (acc ?? 0) + Double(v)
    }

    mutating func add(_ row: RequestRecord) {
        requests += 1
        if let s = row.sessionKey { sessionSet.insert(s) }
        input = UsageAccumulator.plus(input, row.input)
        output = UsageAccumulator.plus(output, row.output)
        cacheRead = UsageAccumulator.plus(cacheRead, row.cacheRead)
        cacheWrite = UsageAccumulator.plus(cacheWrite, row.cacheWrite)
        totalTokens = UsageAccumulator.plus(totalTokens, row.totalTokens)
        if row.totalTokens == nil { unknownTokenRequests += 1 }
        if let c = row.costUsd, c.isFinite {
            costUsd = (costUsd ?? 0) + c
            pricedRequests += 1
        } else {
            unpricedRequests += 1
        }
        if row.stopReason == "error" { errorRequests += 1 }
        if let i = row.input, let c = row.cacheRead {
            hitNum += Double(c)
            hitDen += Double(i) + Double(c)
        }
    }

    func finish() -> UsageTotals {
        return UsageTotals(
            requests: requests,
            sessions: sessionSet.count,
            input: JSCompat.intFromSum(input),
            output: JSCompat.intFromSum(output),
            cacheRead: JSCompat.intFromSum(cacheRead),
            cacheWrite: JSCompat.intFromSum(cacheWrite),
            totalTokens: JSCompat.intFromSum(totalTokens),
            costUsd: costUsd,
            pricedRequests: pricedRequests,
            unpricedRequests: unpricedRequests,
            errorRequests: errorRequests,
            unknownTokenRequests: unknownTokenRequests,
            cacheHitRate: hitDen > 0 ? hitNum / hitDen : nil
        )
    }

    /// totalTokens as the JavaScript comparator sees it (the exact Double sum).
    var totalForSort: Double? { return totalTokens }
}

public enum UsageAnalysis {
    /// Null-safe ascending comparison of dimension values; nulls sort last.
    static func compareNullable(_ a: JSONValue, _ b: JSONValue) -> Int {
        if a == b { return 0 }
        if a.isNull { return 1 }
        if b.isNull { return -1 }
        if case .number(let x) = a, case .number(let y) = b { return cmpSign(x - y) }
        return JSCompat.compare(jsString(a), jsString(b))
    }

    static func jsString(_ v: JSONValue) -> String {
        switch v {
        case .string(let s): return s
        case .number(let d): return JSCompat.numberString(d)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        default: return v.serialized()
        }
    }

    struct Group {
        var dims: [JSONValue]
        var acc: UsageAccumulator
    }

    /// Groups rows by dimension values (insertion order), sorted by
    /// totalTokens desc (null last), requests desc, then dimensions asc.
    static func groupBy(_ rows: [RequestRecord], _ dims: (RequestRecord) -> [JSONValue]) -> [(dims: [JSONValue], totals: UsageTotals)] {
        var order: [String] = []
        var groups: [String: Group] = [:]
        for row in rows {
            let d = dims(row)
            let id = JSONValue.array(d).serialized()
            if groups[id] == nil {
                groups[id] = Group(dims: d, acc: UsageAccumulator())
                order.append(id)
            }
            groups[id]!.acc.add(row)
        }
        let list: [Group] = order.map { groups[$0]! }
        let sorted = stableSorted(list) { a, b -> Int in
            let ta = a.acc.totalForSort
            let tb = b.acc.totalForSort
            if ta != tb {
                guard let x = ta else { return 1 }
                guard let y = tb else { return -1 }
                return cmpSign(y - x)
            }
            if a.acc.requests != b.acc.requests { return b.acc.requests - a.acc.requests > 0 ? 1 : -1 }
            for i in 0..<min(a.dims.count, b.dims.count) {
                let c = compareNullable(a.dims[i], b.dims[i])
                if c != 0 { return c }
            }
            return 0
        }
        return sorted.map { (dims: $0.dims, totals: $0.acc.finish()) }
    }

    public static func summarize(_ rows: [RequestRecord], tzOffsetMinutes: Int = 0,
                                 labels: [String: String] = [:]) throws -> UsageSummary {
        var total = UsageAccumulator()
        for row in rows { total.add(row) }

        var daily: [String: UsageAccumulator] = [:]
        for row in rows {
            guard row.ts.isFinite else { continue }
            let day = try Period.dayKey(row.ts, tzOffsetMinutes: tzOffsetMinutes)
            daily[day, default: UsageAccumulator()].add(row)
        }
        let days = daily.keys.sorted { JSCompat.less($0, $1) }

        let byProvider = groupBy(rows) { [.jStr($0.provider)] }.map {
            ProviderUsage(provider: $0.dims[0].stringValue, totals: $0.totals)
        }
        let byModel = groupBy(rows) { [.jStr($0.provider), .jStr($0.model)] }.map {
            ModelUsage(provider: $0.dims[0].stringValue, model: $0.dims[1].stringValue, totals: $0.totals)
        }
        let byCredential = groupBy(rows) { [.jStr($0.provider), .jInt($0.credentialId)] }.map {
            CredentialUsage(provider: $0.dims[0].stringValue, credentialId: $0.dims[1].intValue, totals: $0.totals)
        }
        let byProject = groupBy(rows) { [.jStr($0.projectKey)] }.map { g -> ProjectUsage in
            let key = g.dims[0].stringValue
            let label: String? = key.flatMap { labels[$0] }
            return ProjectUsage(projectKey: key, label: label, totals: g.totals)
        }
        let byAgentType = groupBy(rows) { [.jStr($0.agentType)] }.map {
            AgentTypeUsage(agentType: $0.dims[0].stringValue, totals: $0.totals)
        }
        let byServiceTier = groupBy(rows) { [.jStr($0.serviceTier)] }.map {
            ServiceTierUsage(serviceTier: $0.dims[0].stringValue, totals: $0.totals)
        }

        return UsageSummary(
            totals: total.finish(),
            byProvider: byProvider,
            byModel: byModel,
            byCredential: byCredential,
            byProject: byProject,
            byAgentType: byAgentType,
            byServiceTier: byServiceTier,
            daily: days.map { DailyUsage(day: $0, totals: daily[$0]!.finish()) }
        )
    }
}
