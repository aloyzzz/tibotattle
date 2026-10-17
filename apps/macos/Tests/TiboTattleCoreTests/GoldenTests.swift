import Foundation
import SQLite3
import XCTest
@testable import TiboTattleCore

/// Swift results must equal the Node implementation's vectors.
final class GoldenTests: XCTestCase {
    func testKeyedDigests() throws {
        let g = try Golden.load("keyed.json")
        let key = try XCTUnwrap(Keyed.data(hex: g["keyHex"].stringValue ?? ""))
        XCTAssertEqual(key.count, 32)
        let cases = try XCTUnwrap(g["cases"].arrayValue)
        XCTAssertGreaterThan(cases.count, 5)
        for c in cases {
            let got = Keyed.digest(key: key, domain: c["domain"].stringValue ?? "", value: c["value"].stringValue ?? "")
            XCTAssertEqual(got, c["expected"].stringValue, c["domain"].stringValue ?? "")
            XCTAssertEqual(got.count, 22)
        }
    }

    func testSessionRecords() throws {
        let root = try XCTUnwrap(try Golden.loadAny("records.json") as? [String: Any])
        let key = try XCTUnwrap(Keyed.data(hex: try XCTUnwrap(root["keyHex"] as? String)))
        let topContext = try XCTUnwrap(root["context"] as? [String: Any])
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 30)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            let context = (c["context"] as? [String: Any]) ?? topContext
            let result = SessionRecord.normalizeEntry(
                c["entry"], key: key,
                sessionKey: context["sessionKey"] as? String,
                projectKey: context["projectKey"] as? String,
                agentType: (context["agentType"] as? String) ?? "main")
            assertJSONEqual(result?.json ?? .null, JSONValue(any: c["expected"]), name)
        }

        let classify = try XCTUnwrap(root["classify"] as? [[String: Any]])
        for c in classify {
            let segments = (c["segments"] as? [String]) ?? []
            XCTAssertEqual(SessionRecord.classifyAgentType(segments), c["expected"] as? String, segments.joined(separator: "/"))
        }

        let vocab = try XCTUnwrap(root["vocab"] as? [[String: Any]])
        for c in vocab {
            let expected = c["expected"] as? String
            XCTAssertEqual(SessionRecord.vocab(c["value"]), expected)
        }
    }

    private func labels(_ options: JSONValue) -> [String: String] {
        var map: [String: String] = [:]
        for field in options["labels"].objectFields ?? [] {
            if let s = field.value.stringValue { map[field.key] = s }
        }
        return map
    }

    func testUsageSummary() throws {
        let g = try Golden.load("usage.json")
        let rows = (g["rows"].arrayValue ?? []).map { RequestRecord(json: $0) }
        XCTAssertGreaterThan(rows.count, 5)

        let options = g["options"]
        let main = try UsageAnalysis.summarize(rows, tzOffsetMinutes: options["tzOffsetMinutes"].intValue ?? 0,
                                               labels: labels(options))
        assertJSONEqual(main.json, g["expected"], "usage")

        for (i, c) in (g["extraCases"].arrayValue ?? []).enumerated() {
            let o = c["options"]
            let summary = try UsageAnalysis.summarize(rows, tzOffsetMinutes: o["tzOffsetMinutes"].intValue ?? 0,
                                                      labels: labels(o))
            assertJSONEqual(summary.json, c["expected"], "usage.extra[\(i)]")
        }

        for p in g["periods"].arrayValue ?? [] {
            let period = try XCTUnwrap(Period(rawValue: p["name"].stringValue ?? ""))
            let range = period.resolve(nowMs: p["nowMs"].doubleValue ?? 0)
            assertJSONEqual(range.json, p["expected"], "period")
        }

        for d in g["dayKeys"].arrayValue ?? [] {
            let key = try Period.dayKey(d["ts"].doubleValue ?? 0, tzOffsetMinutes: d["tzOffsetMinutes"].intValue ?? 0)
            XCTAssertEqual(key, d["expected"].stringValue)
        }
        XCTAssertThrowsError(try Period.dayKey(8.64e15 + 1))
    }

    func testPerformanceSummary() throws {
        let g = try Golden.load("performance.json")
        let cases = try XCTUnwrap(g["cases"].arrayValue)
        XCTAssertGreaterThan(cases.count, 3)
        for (i, c) in cases.enumerated() {
            let rows = (c["rows"].arrayValue ?? []).map { RequestRecord(json: $0) }
            let o = c["options"]
            let tier = try XCTUnwrap(TierFilter(name: o["serviceTier"].stringValue ?? "all"))
            let summary = try PerformanceAnalysis.summarize(rows, tzOffsetMinutes: o["tzOffsetMinutes"].intValue ?? 0,
                                                            serviceTier: tier)
            assertJSONEqual(summary.json, c["expected"], "performance[\(i)]")
        }
        XCTAssertThrowsError(try PerformanceAnalysis.summarize([], serviceTier: .tier("bogus")))
    }

    func testAllowanceSummary() throws {
        let g = try Golden.load("allowance.json")
        let snaps = (g["snapshots"].arrayValue ?? []).map { QuotaSnapshot(json: $0) }
        let o = g["options"]
        let series = try AllowanceAnalysis.summarize(
            snaps, nowMs: try XCTUnwrap(o["nowMs"].doubleValue),
            staleAfterMs: o["staleAfterMs"].doubleValue ?? AllowanceAnalysis.defaultStaleAfterMs)
        assertJSONEqual(.array(series.map { $0.json }), g["expected"], "allowance")
    }

    /// An index written by the Swift Store has exactly Node's tables, columns,
    /// indexes and initial metadata.
    func testIndexSchemaMatchesNode() throws {
        let g = try Golden.load("schema.json")
        let tmp = try TempDir()
        let path = tmp.sub("index.sqlite")
        let store = try Store(path: path)
        store.close()

        let db = try RawDB(path: path, readOnly: true)
        var tables: [JSONField] = []
        for row in try db.rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") {
            let name = try XCTUnwrap(row[0].textValue)
            let columns = try db.rows("PRAGMA table_info(\(name))").map { c -> JSONValue in
                .object([
                    JSONField("name", .jStr(c[1].textValue)),
                    JSONField("type", .jStr(c[2].textValue)),
                    JSONField("notnull", .jInt(c[3].intValue)),
                    JSONField("pk", .jInt(c[5].intValue)),
                ])
            }
            tables.append(JSONField(name, .array(columns)))
        }
        assertJSONEqual(.object(tables), g["tables"], "tables")

        var indexes: [JSONField] = []
        let indexRows = try db.rows(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name")
        for row in indexRows {
            let name = try XCTUnwrap(row[0].textValue)
            let columns = try db.rows("PRAGMA index_info(\(name))").map { JSONValue.jStr($0[2].textValue) }
            indexes.append(JSONField(name, .object([
                JSONField("table", .jStr(row[1].textValue)),
                JSONField("columns", .array(columns)),
            ])))
        }
        assertJSONEqual(.object(indexes), g["indexes"], "indexes")

        let meta = try db.rows("SELECT key, value FROM meta ORDER BY key").map { r -> JSONValue in
            .object([JSONField("key", .jStr(r[0].textValue)), JSONField("value", .jStr(r[1].textValue))])
        }
        assertJSONEqual(.array(meta), g["meta"], "meta")
    }
}
