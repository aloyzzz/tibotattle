import Foundation
import XCTest
@testable import TiboTattleCore

/// Expected strings come from Node (String(n), JSON.stringify, Date.parse).
final class JSCompatTests: XCTestCase {
    func testNumberToString() {
        let cases: [(Double, String)] = [
            (0, "0"), (-0.0, "0"), (1, "1"), (-1, "-1"), (100, "100"), (0.5, "0.5"), (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"), (0.000001234, "0.000001234"), (1e21, "1e+21"),
            (1e20, "100000000000000000000"), (123456789012345680000, "123456789012345680000"),
            (5e-324, "5e-324"), (1767225600000.5, "1767225600000.5"), (0.1 + 0.2, "0.30000000000000004"),
            (9007199254740994, "9007199254740994"), (1767225600000, "1767225600000"), (1e16, "10000000000000000"),
            (-2.5e-10, "-2.5e-10"), (1.7976931348623157e308, "1.7976931348623157e+308"), (123.456, "123.456"),
            (0.0034, "0.0034"),
        ]
        for (value, expected) in cases {
            XCTAssertEqual(JSCompat.numberString(value), expected, "\(value)")
        }
    }

    func testSerializerMatchesJSONStringify() {
        let v: JSONValue = .object([
            JSONField("a", .null),
            JSONField("b", .array([.number(1), .number(2.5), .bool(true), .string("q\"\\\n\t\u{1}\u{2028}é")])),
            JSONField("c", .number(.nan)),
        ])
        XCTAssertEqual(v.serialized(), "{\"a\":null,\"b\":[1,2.5,true,\"q\\\"\\\\\\n\\t\\u0001\u{2028}é\"],\"c\":null}")
    }

    func testDateParse() {
        let cases: [(String, Double?)] = [
            ("2026-01-01T00:00:02.000Z", 1767225602000),
            ("2026-01-01T00:00:02Z", 1767225602000),
            ("2026-01-01T00:00Z", 1767225600000),
            ("2026-01-01", 1767225600000),
            ("2026-01", 1767225600000),
            ("2026", 1767225600000),
            ("2026-02-30T00:00:00Z", 1772409600000),
            ("2026-01-01T24:00:00Z", 1767312000000),
            ("2026-01-01T24:00:01Z", nil),
            ("2026-01-01T00:00:02.1234567Z", 1767225602123),
            ("2026-01-01T00:00:02.1Z", 1767225602100),
            ("2026-01-01T00:00:02+05:30", 1767205802000),
            ("2026-01-01T00:00:02+0530", 1767205802000),
            ("2026-01-01t00:00:02z", 1767225602000),
            ("2026-01-01 00:00:02Z", 1767225602000),
            ("+002026-01-01T00:00:00Z", 1767225600000),
            ("-000000-01-01T00:00:00Z", nil),
            ("2026-01-01T00:00:60Z", nil),
            ("2026-13-01", nil),
            ("2026-01-01T00:00:02.Z", nil),
            (" 2026-01-01T00:00:00Z", nil),
            ("2026-01-01T00:00:00+24:00", nil),
            ("2026-01-01T00:00:00+23:59", 1767139260000),
            ("not a date", nil),
        ]
        for (text, expected) in cases {
            XCTAssertEqual(JSCompat.dateParse(text), expected, text)
        }
    }

    func testRoundingAndDays() throws {
        XCTAssertEqual(JSCompat.round(2.5), 3)
        XCTAssertEqual(JSCompat.round(2.4999), 2)
        XCTAssertEqual(JSCompat.round(-2.5), -2)
        XCTAssertEqual(JSCompat.round(0.49999999999999994), 0)
        XCTAssertEqual(try Period.dayKey(-0.5), "1970-01-01")
        XCTAssertEqual(try Period.dayKey(-1), "1969-12-31")
        XCTAssertEqual(try Period.dayKey(253402300800000), "+010000-01")
        XCTAssertEqual(try Period.dayKey(-62198755200001), "-000002-12")
        XCTAssertEqual(try Period.dayKey(951782400000), "2000-02-29")
    }

    func testStringOrderIsUTF16() {
        // U+FF5E sorts after U+1F642 by scalar value but before it in UTF-16.
        XCTAssertTrue(JSCompat.less("\u{1F642}", "\u{FF5E}"))
        XCTAssertTrue(JSCompat.less("B", "a"))
        XCTAssertEqual(JSCompat.utf16Prefix("abcdefgh", 6), "abcdef")
    }

    func testPathsMatchNodeResolve() {
        XCTAssertEqual(PathUtil.resolve("/a//b/./c/../d/"), "/a/b/d")
        XCTAssertEqual(PathUtil.resolve("x/y", base: "/base"), "/base/x/y")
        XCTAssertEqual(PathUtil.join("/a/", "b"), "/a/b")
        let sources = OmpSources.resolve(environment: ["PI_CONFIG_DIR": ".custom"], home: URL(fileURLWithPath: "/Users/synthetic"))
        XCTAssertEqual(sources.sessionRoots.map { $0.path }, ["/Users/synthetic/.custom/agent/sessions"])
        XCTAssertEqual(sources.agentDbPaths.map { $0.path }, ["/Users/synthetic/.custom/agent/agent.db"])
        let overridden = OmpSources.resolve(environment: ["PI_CODING_AGENT_DIR": "~/omp-agent"], home: URL(fileURLWithPath: "/Users/synthetic"))
        XCTAssertEqual(overridden.sessionRoots.map { $0.path }, ["/Users/synthetic/omp-agent/sessions"])
        let state = StatePaths.defaultDirectory(environment: [:], home: URL(fileURLWithPath: "/Users/synthetic"))
        XCTAssertEqual(state.path, "/Users/synthetic/Library/Application Support/TiboTattle")
        XCTAssertEqual(StatePaths.defaultDirectory(environment: ["TIBOTATTLE_STATE_DIR": "/tmp/tt-state"]).path, "/tmp/tt-state")
    }
}
