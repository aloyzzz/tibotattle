// Read-only, incremental import of omp's recorded subscription usage
// (`usage_history` in agent.db; src/omp/quota-reader.js). Only allowlisted
// columns are selected; email, account_id and every other table are never
// read. Account keys are digested.

import Foundation
import SQLite3

public struct QuotaImportResult: Sendable, Equatable {
    /// "ok", "missing" or "unavailable".
    public var status: String
    public var added: Int
}

public enum QuotaReader {
    static let batch = 5000
    static let columns = [
        "id", "recorded_at", "provider", "account_key", "limit_id", "label", "window_label",
        "used_fraction", "status", "resets_at",
    ]

    struct Cursor: Equatable {
        var id: Int64
        var recordedAt: Double
    }

    private struct SourceFailure: Error {}

    static func isRegularFile(_ path: String) -> Bool {
        var st = stat()
        guard stat(path, &st) == 0 else { return false }
        return Int(st.st_mode) & 0o170000 == 0o100000
    }

    static func msInteger(_ v: SQLValue) -> Double? {
        guard let d = v.numberValue else { return nil }
        return JSCompat.round(d)
    }

    /// `${row.recorded_at}` for a numeric column value.
    static func numberText(_ v: SQLValue) -> String {
        switch v {
        case .integer(let i): return String(i)
        case .real(let d): return JSCompat.numberString(d)
        default: return ""
        }
    }

    /// vocab() applied to a column: NULL -> nil, TEXT -> vocabulary check,
    /// any other type -> "unrecognized".
    static func vocabColumn(_ v: SQLValue) -> String? {
        switch v {
        case .null: return nil
        case .text(let s): return SessionRecord.vocabString(s)
        default: return "unrecognized"
        }
    }

    /// Last imported id plus the newest recorded_at seen; legacy cursors are a bare id.
    static func parseCursor(_ value: String?) -> Cursor {
        let fallback = Cursor(id: 0, recordedAt: -1)
        guard let value = value, let data = value.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return fallback
        }
        if let d = SessionRecord.finiteNumber(parsed) {
            if JSCompat.isSafeInteger(d) && d >= 0 { return Cursor(id: Int64(d), recordedAt: -1) }
            return fallback
        }
        if let obj = parsed as? [String: Any],
           let id = SessionRecord.finiteNumber(obj["id"]), JSCompat.isSafeInteger(id), id >= 0,
           let recordedAt = SessionRecord.finiteNumber(obj["recordedAt"]) {
            return Cursor(id: Int64(id), recordedAt: recordedAt)
        }
        return fallback
    }

    /// JSON.stringify({ id, recordedAt }).
    static func cursorText(_ id: Int64, _ recordedAt: Double) -> String {
        return "{\"id\":\(id),\"recordedAt\":\(JSCompat.numberString(recordedAt))}"
    }

    static func toSnapshot(key: Data, row: [SQLValue]) -> QuotaSnapshot? {
        guard let recordedAt = msInteger(row[1]) else { return nil }
        guard let provider = row[2].textValue, let accountKey = row[3].textValue,
              let limitId = row[4].textValue else { return nil }
        let used = row[7].numberValue
        let keyValue = [numberText(row[1]), provider, accountKey, limitId].joined(separator: "\u{0}")
        return QuotaSnapshot(
            snapshotKey: Keyed.digest(key: key, domain: "snapshot", value: keyValue),
            recordedAt: recordedAt,
            provider: SessionRecord.vocabString(provider),
            accountKey: Keyed.digest(key: key, domain: "account", value: provider + "\u{0}" + accountKey),
            limitId: SessionRecord.vocabString(limitId),
            label: vocabColumn(row[5]),
            windowLabel: vocabColumn(row[6]),
            usedFraction: (used != nil && used! >= 0) ? used : nil,
            status: vocabColumn(row[8]),
            resetsAt: msInteger(row[9])
        )
    }

    /// Imports new usage_history rows from the first existing agent.db.
    /// Source problems return "missing"/"unavailable"; index failures throw.
    public static func importQuotaSnapshots(store: Store, key: Data, agentDbPaths: [String]) throws -> QuotaImportResult {
        guard let dbPath = agentDbPaths.first(where: { isRegularFile($0) }) else {
            return QuotaImportResult(status: "missing", added: 0)
        }
        let metaKey = "quota_cursor:" + Keyed.digest(key: key, domain: "db", value: dbPath)

        var handle: OpaquePointer? = nil
        let rc = sqlite3_open_v2(dbPath, &handle, SQLITE_OPEN_READONLY, nil)
        guard rc == SQLITE_OK, let db = handle else {
            if let h = handle { sqlite3_close_v2(h) }
            return QuotaImportResult(status: "unavailable", added: 0)
        }
        defer { sqlite3_close_v2(db) }

        var added = 0
        do {
            try source { try SQLite.exec(db, "PRAGMA busy_timeout = 2000") }
            let present: Set<String> = try source { () throws -> Set<String> in
                let info = try SQLiteStatement(db: db, sql: "PRAGMA table_info(usage_history)")
                var names = Set<String>()
                for row in try info.all() where row.count > 1 {
                    if let name = row[1].textValue { names.insert(name) }
                }
                return names
            }
            guard columns.allSatisfy({ present.contains($0) }) else {
                return QuotaImportResult(status: "unavailable", added: 0)
            }

            var cursor = try source { () throws -> Cursor in try parseCursor(store.getMeta(metaKey)) }
            let maxId: Double = try source { () throws -> Double in
                let row = try SQLiteStatement(db: db, sql: "SELECT max(id) AS maxId FROM usage_history").first()
                return row?[0].numberValue ?? 0
            }
            if maxId < Double(cursor.id) { cursor = Cursor(id: 0, recordedAt: -1) }

            let sql = "SELECT \(columns.joined(separator: ", ")) FROM usage_history " +
                "WHERE id > ? AND (id > ? OR recorded_at > ?) ORDER BY id LIMIT \(batch)"
            let select = try source { () throws -> SQLiteStatement in try SQLiteStatement(db: db, sql: sql) }
            var after: Int64 = (cursor.id > 0 && cursor.recordedAt >= 0) ? 0 : cursor.id
            var lastId = cursor.id
            var newestRecordedAt = cursor.recordedAt
            while true {
                let rows = try source { () throws -> [[SQLValue]] in
                    try select.all([.integer(after), .integer(cursor.id), SQLValue.num(cursor.recordedAt)])
                }
                if rows.isEmpty { break }
                var snaps: [QuotaSnapshot] = []
                for row in rows {
                    let id: Int64
                    switch row[0] {
                    case .integer(let i): id = i
                    case .real(let d): id = Int64(d.rounded(.towardZero))
                    default: id = after
                    }
                    after = id
                    if id > lastId { lastId = id }
                    if let r = row[1].numberValue, r > newestRecordedAt { newestRecordedAt = r }
                    if let snap = toSnapshot(key: key, row: row) { snaps.append(snap) }
                }
                // Intermediate batches advance only the id; the recorded_at
                // watermark moves once the whole pass is done.
                added += try store.commitSnapshots(metaKey: metaKey, cursorValue: cursorText(lastId, cursor.recordedAt),
                                                   snapshots: snaps)
                if rows.count < batch { break }
            }
            if newestRecordedAt != cursor.recordedAt || lastId != cursor.id {
                try store.commitSnapshots(metaKey: metaKey, cursorValue: cursorText(lastId, newestRecordedAt), snapshots: [])
            }
            return QuotaImportResult(status: "ok", added: added)
        } catch is SourceFailure {
            return QuotaImportResult(status: "unavailable", added: added)
        }
    }

    /// Runs a step against agent.db (or the cursor read); any failure is a
    /// source problem whose details are not surfaced.
    private static func source<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch {
            throw SourceFailure()
        }
    }
}
