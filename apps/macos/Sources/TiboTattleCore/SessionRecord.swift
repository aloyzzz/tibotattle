// Pure normalization of one parsed omp session JSONL entry into an
// allowlisted, content-free request record.
// Message content is never inspected.

import Foundation

/// RequestRecord: every key is always present in JSON (null when unknown).
public struct RequestRecord: Sendable, Equatable {
    public var requestKey: String
    public var ts: Double
    public var provider: String?
    public var api: String?
    public var model: String?
    public var upstreamProvider: String?
    public var serviceTier: String?
    public var credentialId: Int?
    public var agentType: String?
    public var purpose: String?
    public var sessionKey: String?
    public var projectKey: String?
    public var stopReason: String?
    public var input: Int?
    public var output: Int?
    public var cacheRead: Int?
    public var cacheWrite: Int?
    public var totalTokens: Int?
    public var costUsd: Double?
    public var durationMs: Double?
    public var ttftMs: Double?

    public init(requestKey: String, ts: Double, provider: String? = nil, api: String? = nil, model: String? = nil,
                upstreamProvider: String? = nil, serviceTier: String? = nil, credentialId: Int? = nil,
                agentType: String? = nil, purpose: String? = nil, sessionKey: String? = nil,
                projectKey: String? = nil, stopReason: String? = nil, input: Int? = nil, output: Int? = nil,
                cacheRead: Int? = nil, cacheWrite: Int? = nil, totalTokens: Int? = nil, costUsd: Double? = nil,
                durationMs: Double? = nil, ttftMs: Double? = nil) {
        self.requestKey = requestKey
        self.ts = ts
        self.provider = provider
        self.api = api
        self.model = model
        self.upstreamProvider = upstreamProvider
        self.serviceTier = serviceTier
        self.credentialId = credentialId
        self.agentType = agentType
        self.purpose = purpose
        self.sessionKey = sessionKey
        self.projectKey = projectKey
        self.stopReason = stopReason
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.totalTokens = totalTokens
        self.costUsd = costUsd
        self.durationMs = durationMs
        self.ttftMs = ttftMs
    }
}

extension RequestRecord: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("requestKey", .string(requestKey)),
            JSONField("ts", .number(ts)),
            JSONField("provider", .jStr(provider)),
            JSONField("api", .jStr(api)),
            JSONField("model", .jStr(model)),
            JSONField("upstreamProvider", .jStr(upstreamProvider)),
            JSONField("serviceTier", .jStr(serviceTier)),
            JSONField("credentialId", .jInt(credentialId)),
            JSONField("agentType", .jStr(agentType)),
            JSONField("purpose", .jStr(purpose)),
            JSONField("sessionKey", .jStr(sessionKey)),
            JSONField("projectKey", .jStr(projectKey)),
            JSONField("stopReason", .jStr(stopReason)),
            JSONField("input", .jInt(input)),
            JSONField("output", .jInt(output)),
            JSONField("cacheRead", .jInt(cacheRead)),
            JSONField("cacheWrite", .jInt(cacheWrite)),
            JSONField("totalTokens", .jInt(totalTokens)),
            JSONField("costUsd", .jNum(costUsd)),
            JSONField("durationMs", .jNum(durationMs)),
            JSONField("ttftMs", .jNum(ttftMs)),
        ])
    }

    public init(json: JSONValue) {
        self.init(
            requestKey: json["requestKey"].stringValue ?? "",
            ts: json["ts"].doubleValue ?? 0,
            provider: json["provider"].stringValue,
            api: json["api"].stringValue,
            model: json["model"].stringValue,
            upstreamProvider: json["upstreamProvider"].stringValue,
            serviceTier: json["serviceTier"].stringValue,
            credentialId: json["credentialId"].intValue,
            agentType: json["agentType"].stringValue,
            purpose: json["purpose"].stringValue,
            sessionKey: json["sessionKey"].stringValue,
            projectKey: json["projectKey"].stringValue,
            stopReason: json["stopReason"].stringValue,
            input: json["input"].intValue,
            output: json["output"].intValue,
            cacheRead: json["cacheRead"].intValue,
            cacheWrite: json["cacheWrite"].intValue,
            totalTokens: json["totalTokens"].intValue,
            costUsd: json["costUsd"].doubleValue,
            durationMs: json["durationMs"].doubleValue,
            ttftMs: json["ttftMs"].doubleValue
        )
    }
}

extension RequestRecord: Codable {
    public init(from decoder: Decoder) throws {
        self.init(json: try JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

public enum NormalizedEntry: Sendable, Equatable {
    /// Raw session id and cwd for the caller to digest; never stored raw.
    case header(sessionId: String, cwd: String?)
    case request(RequestRecord)

    /// `{ kind: 'header', sessionId, cwd }` or the RequestRecord itself.
    public var json: JSONValue {
        switch self {
        case .header(let sessionId, let cwd):
            return .object([
                JSONField("kind", .string("header")),
                JSONField("sessionId", .string(sessionId)),
                JSONField("cwd", .jStr(cwd)),
            ])
        case .request(let record):
            return record.json
        }
    }
}

public enum SessionRecord {
    static let serviceTiers: Set<String> = ["auto", "default", "flex", "scale", "priority", "ultrafast"]
    static let stopReasons: Set<String> = ["stop", "length", "toolUse", "error", "aborted"]
    static let agentTypes: Set<String> = ["main", "subagent", "advisor"]

    /// 'main' for <project>/<file>.jsonl, 'subagent' deeper, 'advisor' by name.
    public static func classifyAgentType(_ segments: [String]) -> String {
        let base = segments.last ?? ""
        if base == "__advisor.jsonl"
            || (base.hasPrefix("__advisor.") && JSCompat.hasUTF8Suffix(base, ".jsonl")) {
            return "advisor"
        }
        return segments.count <= 2 ? "main" : "subagent"
    }

    /// Keeps strings matching ^[A-Za-z0-9._:/@+ -]{1,128}$; any other
    /// non-null value becomes "unrecognized"; null/absent stays nil.
    public static func vocab(_ value: Any?) -> String? {
        guard let value = value else { return nil }
        if value is NSNull { return nil }
        guard let s = value as? String else { return "unrecognized" }
        return isVocab(s) ? s : "unrecognized"
    }

    static func vocabString(_ s: String?) -> String? {
        guard let s = s else { return nil }
        return isVocab(s) ? s : "unrecognized"
    }

    static func isVocab(_ s: String) -> Bool {
        let bytes = s.utf8
        guard bytes.count >= 1 && bytes.count <= 128 else { return false }
        for b in bytes {
            switch b {
            case 0x41...0x5A, 0x61...0x7A, 0x30...0x39: continue
            case 0x2E, 0x5F, 0x3A, 0x2F, 0x40, 0x2B, 0x20, 0x2D: continue // . _ : / @ + space -
            default: return false
            }
        }
        return true
    }

    // MARK: Typed reads of JSONSerialization values (JavaScript typeof rules)

    static func object(_ v: Any?) -> [String: Any]? {
        return v as? [String: Any]
    }

    static func string(_ v: Any?) -> String? {
        guard let v = v else { return nil }
        if v is NSNull { return nil }
        return v as? String
    }

    /// typeof v === 'number' && Number.isFinite(v)
    static func finiteNumber(_ v: Any?) -> Double? {
        guard let v = v else { return nil }
        guard let n = v as? NSNumber, !(v is String) else { return nil }
        if JSONValue.isBoolean(n) { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    static func isNullish(_ v: Any?) -> Bool {
        guard let v = v else { return true }
        return v is NSNull
    }

    static func tokenCount(_ v: Any?) -> Int? {
        guard let d = finiteNumber(v), d >= 0 else { return nil }
        let r = JSCompat.round(d)
        guard r <= JSCompat.maxSafeInteger else { return nil }
        return Int(r)
    }

    static func nonNegative(_ v: Any?) -> Double? {
        guard let d = finiteNumber(v), d >= 0 else { return nil }
        return d
    }

    static func resolveTimestamp(_ msgTimestamp: Any?, _ entryTimestamp: Any?) -> Double? {
        if let t = finiteNumber(msgTimestamp), t > 0 { return t }
        if let s = string(entryTimestamp), let parsed = JSCompat.dateParse(s) { return parsed }
        return nil
    }

    static func resolveStopReason(_ stopReason: Any?, _ errorMessage: Any?) -> String {
        if isNullish(stopReason) {
            if let m = string(errorMessage), !m.isEmpty { return "error" }
            return "aborted"
        }
        if let s = string(stopReason), stopReasons.contains(s) { return s }
        return "unrecognized"
    }

    /// Returns nil, a header, or a request record (see architecture.md).
    public static func normalizeEntry(_ entry: Any?, key: Data, sessionKey: String? = nil,
                                      projectKey: String? = nil, agentType: String = "main") -> NormalizedEntry? {
        guard let obj = object(entry), let id = string(obj["id"]), !id.isEmpty else { return nil }
        let type = string(obj["type"])

        if type == "session" {
            return .header(sessionId: id, cwd: string(obj["cwd"]))
        }

        let source: [String: Any]
        let purpose: String
        if type == "message" {
            guard let message = object(obj["message"]), string(message["role"]) == "assistant" else { return nil }
            source = message
            purpose = "turn"
        } else if type == "model_usage" {
            source = obj
            purpose = vocab(obj["purpose"]) ?? "auxiliary"
        } else {
            return nil
        }

        guard let provider = string(source["provider"]),
              let model = string(source["model"]),
              let api = string(source["api"]) else { return nil }
        guard let usage = object(source["usage"]) else { return nil }

        guard let ts = resolveTimestamp(source["timestamp"], obj["timestamp"]) else { return nil }

        let input = tokenCount(usage["input"])
        let output = tokenCount(usage["output"])
        let cacheRead = tokenCount(usage["cacheRead"])
        let cacheWrite = tokenCount(usage["cacheWrite"])
        let durationMs = nonNegative(source["duration"])
        var ttftMs = nonNegative(source["ttft"])
        if let t = ttftMs, let d = durationMs, t > d { ttftMs = nil }

        let responseId = string(source["responseId"]) ?? ""
        // No session id in the key, so branch copies of the same turn dedupe.
        let keyValue = [responseId, id, JSCompat.numberString(ts), provider, model].joined(separator: "\u{0}")
        let requestKey = Keyed.digest(key: key, domain: "request", value: keyValue)

        var totalTokens = tokenCount(usage["totalTokens"])
        if totalTokens == nil {
            let known = [input, output, cacheRead, cacheWrite].compactMap { $0 }
            if !known.isEmpty {
                var sum: Double = 0
                for v in known { sum += Double(v) }
                totalTokens = sum <= JSCompat.maxSafeInteger ? Int(sum) : nil
            }
        }

        var credentialId: Int? = nil
        if let c = finiteNumber(source["credentialId"]), JSCompat.isSafeInteger(c), c >= 0 {
            credentialId = Int(c)
        }

        var serviceTier: String? = nil
        if let tier = string(source["serviceTier"]), serviceTiers.contains(tier) {
            serviceTier = tier
        }

        var costUsd: Double? = nil
        if let cost = object(usage["cost"]) {
            costUsd = nonNegative(cost["total"])
        }

        let record = RequestRecord(
            requestKey: requestKey,
            ts: ts,
            provider: vocabString(provider),
            api: vocabString(api),
            model: vocabString(model),
            upstreamProvider: vocab(source["upstreamProvider"]),
            serviceTier: serviceTier,
            credentialId: credentialId,
            agentType: agentTypes.contains(agentType) ? agentType : "unrecognized",
            purpose: purpose,
            sessionKey: sessionKey,
            projectKey: projectKey,
            stopReason: resolveStopReason(source["stopReason"], source["errorMessage"]),
            input: input,
            output: output,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
            totalTokens: totalTokens,
            costUsd: costUsd,
            durationMs: durationMs,
            ttftMs: ttftMs
        )
        return .request(record)
    }
}
