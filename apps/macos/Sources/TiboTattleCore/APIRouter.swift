// In-process JSON API with the same routes, validation, error codes and body
// shapes as src/server.js (minus static files, SSE and the Host check, which
// do not exist without a socket). Errors are fixed codes; input is never echoed.

import Foundation

public enum APIRouter {
    static let getRoutes: Set<String> = ["/api/status", "/api/usage", "/api/performance", "/api/allowance", "/api/overview"]

    struct HTTPError: Error {
        let status: Int
        let code: String
    }

    struct Query {
        var period: Period
        var tz: Int
        var tier: TierFilter
    }

    /// Answers the same routes as src/server.js (minus static files and /api/events).
    /// Returns HTTP-like status and a UTF-8 JSON body. `path` may carry a
    /// `?query`, which is then parsed (with duplicate detection) and merged
    /// with `query`. Blocks while POST /api/refresh runs; call off the main thread.
    public static func handle(method: String, path: String, query: [String: String],
                              headers: [String: String], engine: Engine, now: Date) -> (status: Int, body: Data) {
        var pathOnly = path
        var items: [(String, String)] = []
        if let q = path.firstIndex(of: "?") {
            pathOnly = String(path[path.startIndex..<q])
            let rawQuery = String(path[path.index(after: q)...])
            items.append(contentsOf: parseQueryString(rawQuery))
        }
        for name in query.keys.sorted() {
            if let value = query[name] { items.append((name, value)) }
        }
        return route(method: method, path: pathOnly, items: items, headers: headers, engine: engine, now: now)
    }

    /// Same as above for a full URL (e.g. tibotattle://app/api/usage?period=7d);
    /// repeated query parameters are rejected like URLSearchParams#getAll.
    public static func handle(method: String, url: URL, headers: [String: String],
                              engine: Engine, now: Date) -> (status: Int, body: Data) {
        guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return respond(400, errorBody("bad_request"))
        }
        let items = parseQueryString(comps.percentEncodedQuery ?? "")
        let path = comps.percentEncodedPath.isEmpty ? "/" : comps.percentEncodedPath
        return route(method: method, path: path, items: items, headers: headers, engine: engine, now: now)
    }

    /// application/x-www-form-urlencoded parsing like URLSearchParams.
    static func parseQueryString(_ raw: String) -> [(String, String)] {
        var out: [(String, String)] = []
        for part in raw.split(separator: "&", omittingEmptySubsequences: true) {
            let piece = String(part)
            let name: String
            let value: String
            if let eq = piece.firstIndex(of: "=") {
                name = String(piece[piece.startIndex..<eq])
                value = String(piece[piece.index(after: eq)...])
            } else {
                name = piece
                value = ""
            }
            out.append((formDecode(name), formDecode(value)))
        }
        return out
    }

    static func formDecode(_ s: String) -> String {
        let spaced = s.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }

    static func errorBody(_ code: String) -> JSONValue {
        return .object([JSONField("error", .string(code))])
    }

    static func respond(_ status: Int, _ body: JSONValue) -> (status: Int, body: Data) {
        return (status, body.serializedData())
    }

    static func header(_ headers: [String: String], _ name: String) -> String? {
        let wanted = name.lowercased()
        for (k, v) in headers where k.lowercased() == wanted {
            return v
        }
        return nil
    }

    static func single(_ items: [(String, String)], _ name: String) -> (dup: Bool, value: String?) {
        let all = items.filter { $0.0 == name }.map { $0.1 }
        if all.count > 1 { return (true, nil) }
        return (false, all.first)
    }

    static func isTzText(_ s: String) -> Bool {
        let b = Array(s.utf8)
        var i = 0
        if i < b.count && b[i] == 0x2D { i += 1 }
        let digits = b.count - i
        guard digits >= 1 && digits <= 3 else { return false }
        while i < b.count {
            guard b[i] >= 0x30 && b[i] <= 0x39 else { return false }
            i += 1
        }
        return true
    }

    static func parseQuery(_ items: [(String, String)]) throws -> Query {
        let p = single(items, "period")
        var period = Period.d7
        if p.dup { throw HTTPError(status: 400, code: "bad_period") }
        if let v = p.value {
            guard let parsed = Period(rawValue: v) else { throw HTTPError(status: 400, code: "bad_period") }
            period = parsed
        }
        let t = single(items, "tz")
        var tz = 0
        if t.dup { throw HTTPError(status: 400, code: "bad_tz") }
        if let v = t.value {
            guard isTzText(v), let n = Int(v) else { throw HTTPError(status: 400, code: "bad_tz") }
            if n < -840 || n > 840 { throw HTTPError(status: 400, code: "bad_tz") }
            tz = n
        }
        let r = single(items, "tier")
        var tier = TierFilter.all
        if r.dup { throw HTTPError(status: 400, code: "bad_tier") }
        if let v = r.value {
            guard let parsed = TierFilter(name: v) else { throw HTTPError(status: 400, code: "bad_tier") }
            tier = parsed
        }
        return Query(period: period, tz: tz, tier: tier)
    }

    static func route(method: String, path: String, items: [(String, String)], headers: [String: String],
                      engine: Engine, now: Date) -> (status: Int, body: Data) {
        do {
            if path == "/api/refresh" {
                if method != "POST" { throw HTTPError(status: 405, code: "method_not_allowed") }
                if header(headers, "x-tibotattle") != "1" { throw HTTPError(status: 403, code: "missing_header") }
                let result = try engine.refresh()
                return respond(200, .object([JSONField("generation", .jInt(result.generation))]))
            }
            guard getRoutes.contains(path) else { throw HTTPError(status: 404, code: "not_found") }
            guard method == "GET" else { throw HTTPError(status: 405, code: "method_not_allowed") }

            let q = try parseQuery(items)
            let nowMs = Engine.milliseconds(now)
            switch path {
            case "/api/status":
                return respond(200, engine.status().json)
            case "/api/usage":
                let range = q.period.resolve(nowMs: nowMs)
                let usage = try engine.usage(range: range, tzOffsetMinutes: q.tz)
                return respond(200, .object([JSONField("period", range.json)] + usage.fields))
            case "/api/performance":
                let range = q.period.resolve(nowMs: nowMs)
                let perf = try PerformanceAnalysis.summarize(try engine.rows(range), tzOffsetMinutes: q.tz,
                                                             serviceTier: q.tier)
                return respond(200, .object([JSONField("period", range.json)] + perf.fields))
            case "/api/allowance":
                let series = try engine.allowance(nowMs: nowMs)
                return respond(200, .object([
                    JSONField("nowMs", .number(nowMs)),
                    JSONField("series", .array(series.map { $0.json })),
                ]))
            case "/api/overview":
                let range = q.period.resolve(nowMs: nowMs)
                let data = try engine.rows(range)
                let usage = try UsageAnalysis.summarize(data, tzOffsetMinutes: q.tz, labels: engine.labels)
                let perf = try PerformanceAnalysis.summarize(data, tzOffsetMinutes: q.tz, serviceTier: .all)
                let series = try engine.allowance(nowMs: nowMs)
                return respond(200, .object([
                    JSONField("period", range.json),
                    JSONField("totals", usage.totals.json),
                    JSONField("byProvider", .array(usage.byProvider.map { $0.json })),
                    JSONField("allowance", .array(series.map { $0.json })),
                    JSONField("topModels", .array(perf.models.prefix(5).map { $0.json })),
                ]))
            default:
                throw HTTPError(status: 404, code: "not_found")
            }
        } catch let e as HTTPError {
            return respond(e.status, errorBody(e.code))
        } catch {
            return respond(500, errorBody("internal"))
        }
    }
}
