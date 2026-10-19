// Local SQLite index: content-free request records, quota
// snapshots, per-file read cursors and metadata. Schema v1, WAL,
// busy_timeout 5000, file mode 0600. Forward-only: a newer schema is refused
// with `store_newer` and never rewritten.

import Foundation
import SQLite3

/// Per-file read cursor; dev/ino are decimal strings as the schema stores them.
public struct FileCursor: Sendable, Equatable {
    public var dev: String
    public var ino: String
    public var size: Int
    public var mtimeMs: Double
    public var offset: Int
    public var sessionKey: String?
    public var projectKey: String?
    public var agentType: String?

    public init(dev: String, ino: String, size: Int, mtimeMs: Double, offset: Int,
                sessionKey: String?, projectKey: String?, agentType: String?) {
        self.dev = dev
        self.ino = ino
        self.size = size
        self.mtimeMs = mtimeMs
        self.offset = offset
        self.sessionKey = sessionKey
        self.projectKey = projectKey
        self.agentType = agentType
    }
}

/// One usage_history row after normalization (digests and vocabulary only).
public struct QuotaSnapshot: Sendable, Equatable {
    public var snapshotKey: String?
    public var recordedAt: Double?
    public var provider: String?
    public var accountKey: String?
    public var limitId: String?
    public var label: String?
    public var windowLabel: String?
    public var usedFraction: Double?
    public var status: String?
    public var resetsAt: Double?

    public init(snapshotKey: String?, recordedAt: Double?, provider: String?, accountKey: String?,
                limitId: String?, label: String?, windowLabel: String?, usedFraction: Double?,
                status: String?, resetsAt: Double?) {
        self.snapshotKey = snapshotKey
        self.recordedAt = recordedAt
        self.provider = provider
        self.accountKey = accountKey
        self.limitId = limitId
        self.label = label
        self.windowLabel = windowLabel
        self.usedFraction = usedFraction
        self.status = status
        self.resetsAt = resetsAt
    }
}

extension QuotaSnapshot: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("snapshotKey", .jStr(snapshotKey)),
            JSONField("recordedAt", .jNum(recordedAt)),
            JSONField("provider", .jStr(provider)),
            JSONField("accountKey", .jStr(accountKey)),
            JSONField("limitId", .jStr(limitId)),
            JSONField("label", .jStr(label)),
            JSONField("windowLabel", .jStr(windowLabel)),
            JSONField("usedFraction", .jNum(usedFraction)),
            JSONField("status", .jStr(status)),
            JSONField("resetsAt", .jNum(resetsAt)),
        ])
    }

    public init(json: JSONValue) {
        self.init(
            snapshotKey: json["snapshotKey"].stringValue,
            recordedAt: json["recordedAt"].doubleValue,
            provider: json["provider"].stringValue,
            accountKey: json["accountKey"].stringValue,
            limitId: json["limitId"].stringValue,
            label: json["label"].stringValue,
            windowLabel: json["windowLabel"].stringValue,
            usedFraction: json["usedFraction"].doubleValue,
            status: json["status"].stringValue,
            resetsAt: json["resetsAt"].doubleValue
        )
    }
}

extension QuotaSnapshot: Codable {
    public init(from decoder: Decoder) throws {
        self.init(json: try JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

public struct StoreCounts: Sendable, Equatable {
    public var requests: Int
    public var snapshots: Int
    public var files: Int

    public init(requests: Int, snapshots: Int, files: Int) {
        self.requests = requests
        self.snapshots = snapshots
        self.files = files
    }
}

extension StoreCounts: JSONRepresentable {
    public var json: JSONValue {
        return .object([
            JSONField("requests", .jInt(requests)),
            JSONField("snapshots", .jInt(snapshots)),
            JSONField("files", .jInt(files)),
        ])
    }

    public init(json: JSONValue) {
        self.init(requests: json["requests"].intValue ?? 0,
                  snapshots: json["snapshots"].intValue ?? 0,
                  files: json["files"].intValue ?? 0)
    }
}

extension StoreCounts: Codable {
    public init(from decoder: Decoder) throws {
        self.init(json: try JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

public final class Store: @unchecked Sendable {
    public static let schemaVersion = 1

    /// Schema v1 DDL (pinned by Fixtures/golden/schema.json).
    static let schemaV1 = """
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (
        file_key TEXT PRIMARY KEY, dev TEXT, ino TEXT, size INTEGER, mtime_ms REAL,
        offset INTEGER, session_key TEXT, project_key TEXT, agent_type TEXT, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT, api TEXT, model TEXT,
        upstream_provider TEXT, service_tier TEXT, credential_id INTEGER, agent_type TEXT, purpose TEXT,
        session_key TEXT, project_key TEXT, stop_reason TEXT, input INTEGER, output INTEGER,
        cache_read INTEGER, cache_write INTEGER, total_tokens INTEGER, cost_usd REAL,
        duration_ms REAL, ttft_ms REAL
      );
      CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_key TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL, provider TEXT, account_key TEXT,
        limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS snapshots_series ON snapshots(provider, account_key, limit_id, recorded_at);
    """

    static let requestColumns = [
        "request_key", "ts", "provider", "api", "model", "upstream_provider", "service_tier",
        "credential_id", "agent_type", "purpose", "session_key", "project_key", "stop_reason", "input",
        "output", "cache_read", "cache_write", "total_tokens", "cost_usd", "duration_ms", "ttft_ms",
    ]

    static let snapshotColumns = [
        "snapshot_key", "recorded_at", "provider", "account_key", "limit_id", "label", "window_label",
        "used_fraction", "status", "resets_at",
    ]

    private var db: OpaquePointer?
    private let lock = NSLock()
    private var statements: [String: SQLiteStatement] = [:]
    public let path: String

    /// Opens (creating if needed) the index. Throws `store_newer` for a newer
    /// schema and `store_unavailable` for any other failure. ":memory:" allowed.
    public init(path: String) throws {
        self.path = path
        if path != ":memory:" {
            Store.prepareFile(path)
        }
        var handle: OpaquePointer? = nil
        let rc = sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil)
        guard rc == SQLITE_OK, let opened = handle else {
            if let h = handle { sqlite3_close_v2(h) }
            throw TiboTattleError.storeUnavailable
        }
        do {
            try SQLite.exec(opened, "PRAGMA busy_timeout = 5000")
            let version = try Store.readSchemaVersion(opened)
            if let v = version, v > Double(Store.schemaVersion) {
                throw TiboTattleError.storeNewer
            }
            if path != ":memory:" {
                try SQLite.exec(opened, "PRAGMA journal_mode = WAL")
            }
            try SQLite.exec(opened, "BEGIN IMMEDIATE")
            do {
                try SQLite.exec(opened, Store.schemaV1)
                if version == nil {
                    let insert = try SQLiteStatement(db: opened, sql: "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)")
                    try insert.run([.text(String(Store.schemaVersion))])
                }
                try SQLite.exec(opened, "COMMIT")
            } catch {
                try? SQLite.exec(opened, "ROLLBACK")
                throw error
            }
        } catch let error as TiboTattleError where error == TiboTattleError.storeNewer {
            sqlite3_close_v2(opened)
            throw error
        } catch {
            sqlite3_close_v2(opened)
            throw TiboTattleError.storeUnavailable
        }
        db = opened
    }

    deinit {
        close()
    }

    /// Create owner-only before SQLite opens it; tighten an existing file too.
    static func prepareFile(_ path: String) {
        let fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, mode_t(0o600))
        if fd >= 0 { Darwin.close(fd) }
        _ = chmod(path, mode_t(0o600))
    }

    /// nil when there is no version; +Infinity for unparseable versions (fail closed).
    static func readSchemaVersion(_ db: OpaquePointer) throws -> Double? {
        let hasMeta = try SQLiteStatement(db: db, sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").first()
        if hasMeta == nil { return nil }
        guard let row = try SQLiteStatement(db: db, sql: "SELECT value FROM meta WHERE key = 'schema_version'").first() else {
            return nil
        }
        let version: Double
        switch row[0] {
        case .null, .blob: version = 0
        case .integer(let i): version = Double(i)
        case .real(let d): version = d
        case .text(let s): version = JSCompat.numberFromString(s)
        }
        return JSCompat.isSafeInteger(version) && version > 0 ? version : Double.infinity
    }

    // MARK: Internals (call with lock held)

    private func handle() throws -> OpaquePointer {
        guard let db = db else { throw TiboTattleError.storeUnavailable }
        return db
    }

    private func statement(_ sql: String) throws -> SQLiteStatement {
        if let s = statements[sql] { return s }
        let s = try SQLiteStatement(db: try handle(), sql: sql)
        statements[sql] = s
        return s
    }

    private func transaction<T>(_ body: () throws -> T) throws -> T {
        let db = try handle()
        try SQLite.exec(db, "BEGIN IMMEDIATE")
        do {
            let result = try body()
            try SQLite.exec(db, "COMMIT")
            return result
        } catch {
            try? SQLite.exec(db, "ROLLBACK")
            throw error
        }
    }

    private func locked<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        do {
            return try body()
        } catch let error as TiboTattleError {
            throw error
        } catch {
            throw TiboTattleError.storeUnavailable
        }
    }

    private func setMetaUnlocked(_ key: String, _ value: String?) throws {
        try statement("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run([.text(key), .str(value)])
    }

    private static func insertSQL(_ table: String, _ columns: [String]) -> String {
        let marks = columns.map { _ in "?" }.joined(separator: ", ")
        return "INSERT OR IGNORE INTO \(table) (\(columns.joined(separator: ", "))) VALUES (\(marks))"
    }

    private static func nowMs() -> Int64 {
        return Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
    }

    // MARK: Public API

    public func getMeta(_ key: String) throws -> String? {
        return try locked { () throws -> String? in
            guard let row = try statement("SELECT value FROM meta WHERE key = ?").first([.text(key)]) else { return nil }
            return row[0].textCast
        }
    }

    public func setMeta(_ key: String, _ value: String?) throws {
        try locked { try setMetaUnlocked(key, value) }
    }

    public func getCursor(_ fileKey: String) throws -> FileCursor? {
        return try locked { () throws -> FileCursor? in
            let sql = "SELECT dev, ino, size, mtime_ms, offset, session_key, project_key, agent_type FROM files WHERE file_key = ?"
            guard let row = try statement(sql).first([.text(fileKey)]) else { return nil }
            return FileCursor(
                dev: row[0].textCast ?? "",
                ino: row[1].textCast ?? "",
                size: row[2].intValue ?? -1,
                mtimeMs: row[3].numberValue ?? -1,
                offset: row[4].intValue ?? 0,
                sessionKey: row[5].textValue,
                projectKey: row[6].textValue,
                agentType: row[7].textValue
            )
        }
    }

    /// Inserts records and moves the file cursor atomically; returns the inserted count.
    @discardableResult
    public func commitFile(_ fileKey: String, cursor: FileCursor, records: [RequestRecord]) throws -> Int {
        return try locked { () throws -> Int in
            try transaction { () throws -> Int in
                var inserted = 0
                let insert = try statement(Store.insertSQL("requests", Store.requestColumns))
                let db = try handle()
                for r in records {
                    try insert.run([
                        .text(r.requestKey), .num(r.ts), .str(r.provider), .str(r.api), .str(r.model),
                        .str(r.upstreamProvider), .str(r.serviceTier), .optInt(r.credentialId),
                        .str(r.agentType), .str(r.purpose), .str(r.sessionKey), .str(r.projectKey),
                        .str(r.stopReason), .optInt(r.input), .optInt(r.output), .optInt(r.cacheRead),
                        .optInt(r.cacheWrite), .optInt(r.totalTokens), .num(r.costUsd), .num(r.durationMs),
                        .num(r.ttftMs),
                    ])
                    inserted += Int(sqlite3_changes(db))
                }
                let put = """
                    INSERT INTO files (file_key, dev, ino, size, mtime_ms, offset, session_key, project_key, agent_type, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(file_key) DO UPDATE SET dev = excluded.dev, ino = excluded.ino, size = excluded.size,
                      mtime_ms = excluded.mtime_ms, offset = excluded.offset, session_key = excluded.session_key,
                      project_key = excluded.project_key, agent_type = excluded.agent_type, updated_at = excluded.updated_at
                    """
                try statement(put).run([
                    .text(fileKey), .text(cursor.dev), .text(cursor.ino), .integer(Int64(cursor.size)),
                    .real(cursor.mtimeMs), .integer(Int64(cursor.offset)), .str(cursor.sessionKey),
                    .str(cursor.projectKey), .str(cursor.agentType), .integer(Store.nowMs()),
                ])
                return inserted
            }
        }
    }

    /// Inserts snapshots and stores the import cursor atomically; returns the inserted count.
    @discardableResult
    public func commitSnapshots(metaKey: String, cursorValue: String?, snapshots: [QuotaSnapshot]) throws -> Int {
        return try locked { () throws -> Int in
            try transaction { () throws -> Int in
                var inserted = 0
                let insert = try statement(Store.insertSQL("snapshots", Store.snapshotColumns))
                let db = try handle()
                for s in snapshots {
                    try insert.run([
                        .str(s.snapshotKey), .num(s.recordedAt), .str(s.provider), .str(s.accountKey),
                        .str(s.limitId), .str(s.label), .str(s.windowLabel), .num(s.usedFraction),
                        .str(s.status), .num(s.resetsAt),
                    ])
                    inserted += Int(sqlite3_changes(db))
                }
                try setMetaUnlocked(metaKey, cursorValue)
                return inserted
            }
        }
    }

    /// Request rows with ts in [fromMs, toMs), ordered by ts then request_key.
    public func queryRequests(fromMs: Double = 0, toMs: Double = 9007199254740991) throws -> [RequestRecord] {
        return try locked { () throws -> [RequestRecord] in
            let sql = "SELECT \(Store.requestColumns.joined(separator: ", ")) FROM requests WHERE ts >= ? AND ts < ? ORDER BY ts, request_key"
            let rows = try statement(sql).all([.num(fromMs), .num(toMs)])
            return rows.map { c in
                RequestRecord(
                    requestKey: c[0].textCast ?? "",
                    ts: c[1].numberValue ?? 0,
                    provider: c[2].textValue,
                    api: c[3].textValue,
                    model: c[4].textValue,
                    upstreamProvider: c[5].textValue,
                    serviceTier: c[6].textValue,
                    credentialId: c[7].intValue,
                    agentType: c[8].textValue,
                    purpose: c[9].textValue,
                    sessionKey: c[10].textValue,
                    projectKey: c[11].textValue,
                    stopReason: c[12].textValue,
                    input: c[13].intValue,
                    output: c[14].intValue,
                    cacheRead: c[15].intValue,
                    cacheWrite: c[16].intValue,
                    totalTokens: c[17].intValue,
                    costUsd: c[18].numberValue,
                    durationMs: c[19].numberValue,
                    ttftMs: c[20].numberValue
                )
            }
        }
    }

    /// Snapshots with recordedAt in [fromMs, toMs), ordered by recordedAt then snapshot_key.
    public func querySnapshots(fromMs: Double = 0, toMs: Double = 9007199254740991) throws -> [QuotaSnapshot] {
        return try locked { () throws -> [QuotaSnapshot] in
            let sql = "SELECT \(Store.snapshotColumns.joined(separator: ", ")) FROM snapshots WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at, snapshot_key"
            let rows = try statement(sql).all([.num(fromMs), .num(toMs)])
            return rows.map { c in
                QuotaSnapshot(
                    snapshotKey: c[0].textValue,
                    recordedAt: c[1].numberValue,
                    provider: c[2].textValue,
                    accountKey: c[3].textValue,
                    limitId: c[4].textValue,
                    label: c[5].textValue,
                    windowLabel: c[6].textValue,
                    usedFraction: c[7].numberValue,
                    status: c[8].textValue,
                    resetsAt: c[9].numberValue
                )
            }
        }
    }

    public func counts() throws -> StoreCounts {
        return try locked { () throws -> StoreCounts in
            func count(_ table: String) throws -> Int {
                let row = try self.statement("SELECT count(*) FROM \(table)").first()
                return row?[0].intValue ?? 0
            }
            return StoreCounts(requests: try count("requests"), snapshots: try count("snapshots"), files: try count("files"))
        }
    }

    public func close() {
        lock.lock()
        defer { lock.unlock() }
        statements.removeAll()
        if let db = db {
            sqlite3_close_v2(db)
        }
        db = nil
    }
}
