import Foundation
import SQLite3
import XCTest
@testable import TiboTattleCore

/// Frozen vectors in Fixtures/golden next to the tests. They were generated
/// from the retired Node implementation (commit f140a49) and now pin the
/// behavior; they are edited by hand, never regenerated.
enum Golden {
    static var directory: URL {
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/golden")
            .standardizedFileURL
    }

    static func loadAny(_ name: String) throws -> Any {
        let data = try Data(contentsOf: directory.appendingPathComponent(name))
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    static func load(_ name: String) throws -> JSONValue {
        return JSONValue(any: try loadAny(name))
    }
}

/// Generic JSON comparison: objects by key set (order-insensitive), arrays in
/// order, strings by UTF-16 code units, numbers with a relative tolerance.
func compareJSON(_ actual: JSONValue, _ expected: JSONValue, _ path: String, _ tolerance: Double,
                 _ failures: inout [String]) {
    switch (actual, expected) {
    case (.null, .null):
        return
    case let (.bool(a), .bool(e)):
        if a != e { failures.append("\(path): \(a) != \(e)") }
    case let (.number(a), .number(e)):
        if !numbersClose(a, e, tolerance) { failures.append("\(path): \(a) != \(e)") }
    case let (.string(a), .string(e)):
        if Array(a.utf16) != Array(e.utf16) { failures.append("\(path): \"\(a)\" != \"\(e)\"") }
    case let (.array(a), .array(e)):
        if a.count != e.count {
            failures.append("\(path): array length \(a.count) != \(e.count)")
            return
        }
        for i in 0..<a.count {
            compareJSON(a[i], e[i], "\(path)[\(i)]", tolerance, &failures)
        }
    case let (.object(a), .object(e)):
        let aKeys = Set(a.map { $0.key })
        let eKeys = Set(e.map { $0.key })
        if aKeys != eKeys {
            let missing = eKeys.subtracting(aKeys).sorted()
            let extra = aKeys.subtracting(eKeys).sorted()
            failures.append("\(path): keys differ, missing \(missing), extra \(extra)")
            return
        }
        for k in eKeys.sorted() {
            compareJSON(actual[k], expected[k], "\(path).\(k)", tolerance, &failures)
        }
    default:
        failures.append("\(path): \(actual.serialized().prefix(80)) != \(expected.serialized().prefix(80))")
    }
}

func numbersClose(_ a: Double, _ e: Double, _ tolerance: Double) -> Bool {
    if a == e { return true }
    return abs(a - e) <= tolerance * max(abs(a), abs(e))
}

func assertJSONEqual(_ actual: JSONValue, _ expected: JSONValue, _ label: String = "$",
                     tolerance: Double = 1e-9, file: StaticString = #filePath, line: UInt = #line) {
    var failures: [String] = []
    compareJSON(actual, expected, label, tolerance, &failures)
    if !failures.isEmpty {
        XCTFail(failures.prefix(12).joined(separator: "\n"), file: file, line: line)
    }
}

final class TempDir {
    let url: URL

    init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("tt-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }

    var path: String { return url.path }

    func sub(_ relative: String) -> String {
        return url.path + "/" + relative
    }
}

func writeFile(_ path: String, _ text: String) throws {
    let dir = (path as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try Data(text.utf8).write(to: URL(fileURLWithPath: path))
}

func appendFile(_ path: String, _ text: String) throws {
    guard let handle = FileHandle(forWritingAtPath: path) else {
        throw TiboTattleError("test_open_failed")
    }
    defer { handle.closeFile() }
    handle.seekToEndOfFile()
    handle.write(Data(text.utf8))
}

/// Concatenated bytes of an SQLite file and its WAL/SHM side files.
func indexBytes(_ path: String) -> Data {
    var all = Data()
    for suffix in ["", "-wal", "-shm", "-journal"] {
        if let d = FileManager.default.contents(atPath: path + suffix) { all.append(d) }
    }
    return all
}

func assertNoSentinels(_ data: Data, _ sentinels: [String], file: StaticString = #filePath, line: UInt = #line) {
    for s in sentinels {
        XCTAssertNil(data.range(of: Data(s.utf8)), "sentinel \(s) found in index", file: file, line: line)
    }
}

/// Raw SQLite handle for test setup and inspection.
final class RawDB {
    let handle: OpaquePointer

    init(path: String, readOnly: Bool = false) throws {
        var db: OpaquePointer? = nil
        let flags = readOnly ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, let opened = db else {
            if let d = db { sqlite3_close_v2(d) }
            throw TiboTattleError("test_db_open_failed")
        }
        handle = opened
    }

    deinit {
        sqlite3_close_v2(handle)
    }

    func exec(_ sql: String) throws {
        try SQLite.exec(handle, sql)
    }

    func rows(_ sql: String, _ values: [SQLValue] = []) throws -> [[SQLValue]] {
        let stmt = try SQLiteStatement(db: handle, sql: sql)
        return try stmt.all(values)
    }

    func run(_ sql: String, _ values: [SQLValue]) throws {
        let stmt = try SQLiteStatement(db: handle, sql: sql)
        try stmt.run(values)
    }
}

func jsonLine(_ object: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [])
    return String(decoding: data, as: UTF8.self) + "\n"
}
