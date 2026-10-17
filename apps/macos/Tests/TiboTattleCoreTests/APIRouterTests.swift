import Foundation
import XCTest
@testable import TiboTattleCore

final class APIRouterTests: XCTestCase {
    var tmp: TempDir!
    var engine: Engine!
    let now = Date(timeIntervalSince1970: 1767225600)

    override func setUpWithError() throws {
        tmp = try TempDir()
        let agent = tmp.sub("agent")
        let message: [String: Any] = [
            "role": "assistant", "api": "test-api", "provider": "prov", "model": "model-a",
            "usage": ["input": 10, "output": 20, "cacheRead": 5, "cacheWrite": 0, "totalTokens": 35,
                      "cost": ["total": 0.01] as [String: Any]] as [String: Any],
            "stopReason": "stop", "timestamp": 1767225500000, "duration": 1000, "ttft": 100,
        ]
        let lines = jsonLine(["type": "session", "id": "synthetic-session", "cwd": "/synthetic/project-alpha"])
            + jsonLine(["type": "message", "id": "a1", "timestamp": "2025-12-31T23:58:20.000Z", "message": message])
        try writeFile(agent + "/sessions/proj/s1.jsonl", lines)
        let sources = OmpSources.resolve(environment: ["PI_CODING_AGENT_DIR": agent], home: tmp.url)
        engine = try Engine(sources: sources, stateDirectory: URL(fileURLWithPath: tmp.sub("state")))
    }

    override func tearDown() {
        engine?.close()
        engine = nil
        tmp = nil
        super.tearDown()
    }

    func call(_ method: String, _ path: String, _ query: [String: String] = [:],
              headers: [String: String] = [:]) -> (status: Int, json: JSONValue) {
        let response = APIRouter.handle(method: method, path: path, query: query, headers: headers, engine: engine, now: now)
        return (response.status, JSONValue.parse(response.body) ?? .null)
    }

    func keys(_ v: JSONValue) -> [String] {
        return (v.objectFields ?? []).map { $0.key }.sorted()
    }

    func testErrorCodes() {
        func expect(_ r: (status: Int, json: JSONValue), _ status: Int, _ code: String, line: UInt = #line) {
            XCTAssertEqual(r.status, status, line: line)
            XCTAssertEqual(r.json["error"].stringValue, code, line: line)
            XCTAssertEqual(keys(r.json), ["error"], line: line)
        }
        expect(call("GET", "/api/usage", ["period": "bogus"]), 400, "bad_period")
        expect(call("GET", "/api/status", ["period": "1y"]), 400, "bad_period")
        expect(call("GET", "/api/usage", ["tz": "abc"]), 400, "bad_tz")
        expect(call("GET", "/api/usage", ["tz": "900"]), 400, "bad_tz")
        expect(call("GET", "/api/usage", ["tz": "+60"]), 400, "bad_tz")
        expect(call("GET", "/api/usage", ["tz": "1000"]), 400, "bad_tz")
        expect(call("GET", "/api/usage", ["tz": ""]), 400, "bad_tz")
        expect(call("GET", "/api/performance", ["tier": "turbo"]), 400, "bad_tier")
        expect(call("GET", "/api/usage?period=7d&period=24h"), 400, "bad_period")
        expect(call("POST", "/api/refresh"), 403, "missing_header")
        expect(call("POST", "/api/refresh", headers: ["X-TiboTattle": "0"]), 403, "missing_header")
        expect(call("GET", "/api/refresh"), 405, "method_not_allowed")
        expect(call("POST", "/api/usage"), 405, "method_not_allowed")
        expect(call("HEAD", "/api/status"), 405, "method_not_allowed")
        expect(call("GET", "/api/nope"), 404, "not_found")
        expect(call("GET", "/api/events"), 404, "not_found")
        expect(call("GET", "/"), 404, "not_found")

        let url = URL(string: "tibotattle://app/api/usage?tz=60&tz=0")!
        let r = APIRouter.handle(method: "GET", url: url, headers: [:], engine: engine, now: now)
        XCTAssertEqual(r.status, 400)
        XCTAssertEqual(JSONValue.parse(r.body)?["error"].stringValue, "bad_tz")
    }

    func testShapesAfterRefresh() throws {
        let refresh = call("POST", "/api/refresh", headers: ["x-tibotattle": "1"])
        XCTAssertEqual(refresh.status, 200)
        XCTAssertEqual(keys(refresh.json), ["generation"])
        XCTAssertEqual(refresh.json["generation"].intValue, 1)

        let again = call("POST", "/api/refresh", headers: ["X-TiboTattle": "1"])
        XCTAssertEqual(again.json["generation"].intValue, 1) // nothing new: generation unchanged

        let status = call("GET", "/api/status")
        XCTAssertEqual(status.status, 200)
        XCTAssertEqual(keys(status.json), ["counts", "generation", "lastError", "lastRefreshAt", "refreshing", "sources"])
        XCTAssertTrue(status.json["lastError"].isNull)
        XCTAssertEqual(status.json["refreshing"].boolValue, false)
        XCTAssertEqual(status.json["sources"]["agentDb"].stringValue, "missing")
        XCTAssertEqual(status.json["sources"]["sessionRoots"].arrayValue?.first?["status"].stringValue, "readable")
        XCTAssertEqual(status.json["counts"]["requests"].intValue, 1)

        let usage = call("GET", "/api/usage", ["period": "24h", "tz": "-0"])
        XCTAssertEqual(usage.status, 200)
        XCTAssertEqual(keys(usage.json), ["byAgentType", "byCredential", "byModel", "byProject", "byProvider",
                                          "byServiceTier", "daily", "period", "totals"])
        XCTAssertEqual(keys(usage.json["period"]), ["fromMs", "name", "toMs"])
        XCTAssertEqual(usage.json["period"]["name"].stringValue, "24h")
        XCTAssertEqual(usage.json["period"]["toMs"].doubleValue, 1767225600001)
        XCTAssertEqual(usage.json["totals"]["requests"].intValue, 1)
        XCTAssertEqual(usage.json["totals"]["costUsd"].doubleValue, 0.01)
        XCTAssertEqual(usage.json["byProject"].arrayValue?.first?["label"].stringValue, "project-alpha")
        XCTAssertTrue(usage.json["totals"]["cacheWrite"].doubleValue == 0)

        let perf = call("GET", "/api/performance", ["tier": "unreported"])
        XCTAssertEqual(perf.status, 200)
        XCTAssertEqual(keys(perf.json), ["models", "period", "tiers"])
        XCTAssertEqual(perf.json["models"].arrayValue?.count, 1)

        let allowance = call("GET", "/api/allowance")
        XCTAssertEqual(allowance.status, 200)
        XCTAssertEqual(keys(allowance.json), ["nowMs", "series"])
        XCTAssertEqual(allowance.json["nowMs"].doubleValue, 1767225600000)

        let overview = call("GET", "/api/overview", ["period": "all"])
        XCTAssertEqual(overview.status, 200)
        XCTAssertEqual(keys(overview.json), ["allowance", "byProvider", "period", "topModels", "totals"])
        XCTAssertEqual(overview.json["period"]["fromMs"].doubleValue, 0)

        // The typed API agrees with the routed JSON.
        let typed = try engine.usage(period: .d7, tzOffsetMinutes: 0, now: now)
        XCTAssertEqual(typed.totals.requests, 1)
        XCTAssertEqual(typed.byModel.first?.model, "model-a")
        let typedPerf = try engine.performance(period: .all, tzOffsetMinutes: 0, tier: .all, now: now)
        XCTAssertEqual(typedPerf.models.first?.decodeTps.median, 20 / 0.9)
        XCTAssertEqual(try engine.allowance(now: now).count, 0)
        XCTAssertEqual(engine.labels.values.sorted(), ["project-alpha"])

        // Explicit nulls survive Codable encoding.
        let encoded = try JSONEncoder().encode(typed.totals)
        let decoded = try XCTUnwrap(JSONValue.parse(encoded))
        XCTAssertTrue(decoded.objectFields?.contains { $0.key == "cacheHitRate" } ?? false)
        let roundTrip = try JSONDecoder().decode(UsageSummary.self, from: try JSONEncoder().encode(typed))
        XCTAssertEqual(roundTrip, typed)
    }

    func testStateFilesAreOwnerOnly() throws {
        func mode(_ path: String) -> Int {
            var st = stat()
            let rc = stat(path, &st)
            return rc == 0 ? Int(st.st_mode) & 0o777 : -1
        }
        XCTAssertEqual(mode(tmp.sub("state")), 0o700)
        XCTAssertEqual(mode(tmp.sub("state/identity.key")), 0o600)
        XCTAssertEqual(mode(tmp.sub("state/index.sqlite")), 0o600)
        let key = try XCTUnwrap(FileManager.default.contents(atPath: tmp.sub("state/identity.key")))
        XCTAssertEqual(key.count, 32)
        // A second engine on the same state directory reuses the key.
        let other = try Engine(sources: engine.sources, stateDirectory: URL(fileURLWithPath: tmp.sub("state")))
        XCTAssertEqual(other.key, engine.key)
        other.close()
    }

    func testConcurrentRefreshesCollapse() throws {
        final class Results: @unchecked Sendable {
            let lock = NSLock()
            var values: [Int] = []
            func add(_ v: Int) {
                lock.lock()
                values.append(v)
                lock.unlock()
            }
        }
        let results = Results()
        let engine: Engine = self.engine
        let group = DispatchGroup()
        for _ in 0..<8 {
            group.enter()
            DispatchQueue.global().async {
                let r = try? engine.refresh()
                results.add(r?.generation ?? -1)
                group.leave()
            }
        }
        group.wait()
        XCTAssertEqual(results.values.count, 8)
        XCTAssertTrue(results.values.allSatisfy { $0 == 1 })
        XCTAssertEqual(engine.generation, 1)
    }
}
