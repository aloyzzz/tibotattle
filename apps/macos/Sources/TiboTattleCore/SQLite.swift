// Minimal SQLite3 C API wrapper shared by the index store and the read-only
// agent.db reader. Errors carry only the SQLite result code internally.

import Foundation
import SQLite3

let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct SQLiteError: Error {
    let resultCode: Int32
}

enum SQLValue: Equatable {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob

    /// typeof value === 'number' (INTEGER or REAL).
    var numberValue: Double? {
        switch self {
        case .integer(let i): return Double(i)
        case .real(let d): return d.isFinite ? d : nil
        default: return nil
        }
    }

    var textValue: String? {
        if case .text(let s) = self { return s }
        return nil
    }

    /// Text representation the way SQLite would CAST it (for meta values).
    var textCast: String? {
        switch self {
        case .text(let s): return s
        case .integer(let i): return String(i)
        case .real(let d): return JSCompat.numberString(d)
        default: return nil
        }
    }

    var intValue: Int? {
        switch self {
        case .integer(let i): return Int(i)
        case .real(let d): return JSCompat.intIfIntegral(d)
        default: return nil
        }
    }

    /// Binds a JavaScript-style number: integral values as INTEGER, others as REAL.
    static func num(_ d: Double?) -> SQLValue {
        guard let d = d, d.isFinite else { return .null }
        if d.rounded(.towardZero) == d && abs(d) < 9.2e18 { return .integer(Int64(d)) }
        return .real(d)
    }

    static func str(_ s: String?) -> SQLValue {
        guard let s = s else { return .null }
        return .text(s)
    }

    static func optInt(_ i: Int?) -> SQLValue {
        guard let i = i else { return .null }
        return .integer(Int64(i))
    }
}

final class SQLiteStatement {
    let handle: OpaquePointer

    init(db: OpaquePointer, sql: String) throws {
        var stmt: OpaquePointer? = nil
        let rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard rc == SQLITE_OK, let prepared = stmt else {
            if let s = stmt { sqlite3_finalize(s) }
            throw SQLiteError(resultCode: rc)
        }
        handle = prepared
    }

    deinit {
        sqlite3_finalize(handle)
    }

    func bind(_ values: [SQLValue]) throws {
        sqlite3_reset(handle)
        sqlite3_clear_bindings(handle)
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let rc: Int32
            switch value {
            case .null, .blob:
                rc = sqlite3_bind_null(handle, index)
            case .integer(let i):
                rc = sqlite3_bind_int64(handle, index, i)
            case .real(let d):
                rc = sqlite3_bind_double(handle, index, d)
            case .text(let s):
                rc = sqlite3_bind_text(handle, index, s, -1, sqliteTransient)
            }
            if rc != SQLITE_OK { throw SQLiteError(resultCode: rc) }
        }
    }

    /// Runs to completion, discarding rows.
    func run(_ values: [SQLValue] = []) throws {
        try bind(values)
        defer { sqlite3_reset(handle) }
        while true {
            let rc = sqlite3_step(handle)
            if rc == SQLITE_DONE { return }
            if rc != SQLITE_ROW { throw SQLiteError(resultCode: rc) }
        }
    }

    /// All rows as arrays of column values.
    func all(_ values: [SQLValue] = []) throws -> [[SQLValue]] {
        try bind(values)
        defer { sqlite3_reset(handle) }
        var rows: [[SQLValue]] = []
        let count = sqlite3_column_count(handle)
        while true {
            let rc = sqlite3_step(handle)
            if rc == SQLITE_DONE { break }
            if rc != SQLITE_ROW { throw SQLiteError(resultCode: rc) }
            var row: [SQLValue] = []
            row.reserveCapacity(Int(count))
            var i: Int32 = 0
            while i < count {
                row.append(column(i))
                i += 1
            }
            rows.append(row)
        }
        return rows
    }

    func first(_ values: [SQLValue] = []) throws -> [SQLValue]? {
        try bind(values)
        defer { sqlite3_reset(handle) }
        let rc = sqlite3_step(handle)
        if rc == SQLITE_DONE { return nil }
        if rc != SQLITE_ROW { throw SQLiteError(resultCode: rc) }
        let count = sqlite3_column_count(handle)
        var row: [SQLValue] = []
        var i: Int32 = 0
        while i < count {
            row.append(column(i))
            i += 1
        }
        return row
    }

    func column(_ i: Int32) -> SQLValue {
        switch sqlite3_column_type(handle, i) {
        case SQLITE_INTEGER:
            return .integer(sqlite3_column_int64(handle, i))
        case SQLITE_FLOAT:
            return .real(sqlite3_column_double(handle, i))
        case SQLITE_TEXT:
            guard let p = sqlite3_column_text(handle, i) else { return .text("") }
            let n = Int(sqlite3_column_bytes(handle, i))
            return .text(String(decoding: UnsafeBufferPointer(start: p, count: n), as: UTF8.self))
        case SQLITE_BLOB:
            return .blob
        default:
            return .null
        }
    }
}

enum SQLite {
    static func exec(_ db: OpaquePointer, _ sql: String) throws {
        var message: UnsafeMutablePointer<CChar>? = nil
        let rc = sqlite3_exec(db, sql, nil, nil, &message)
        if let m = message { sqlite3_free(m) }
        if rc != SQLITE_OK { throw SQLiteError(resultCode: rc) }
    }
}
