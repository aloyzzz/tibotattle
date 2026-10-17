import Foundation
import SQLite3
import XCTest
@testable import TiboTattleCore

final class QuotaReaderTests: XCTestCase {
    let key = Data(repeating: 7, count: 32)
    let email = "EMAILSENTINEL@example.invalid"
    let accountId = "ACCOUNTIDSENTINEL"
    let accountKey = "ACCOUNTKEYSENTINEL"
    let secret = "CREDENTIALSECRETSENTINEL"
    let base: Int64 = 1768470000000

    var tmp: TempDir!
    var store: Store!
    var dbPath: String!

    override func setUpWithError() throws {
        tmp = try TempDir()
        try FileManager.default.createDirectory(atPath: tmp.sub("agent"), withIntermediateDirectories: true)
        dbPath = tmp.sub("agent/agent.db")
        store = try Store(path: tmp.sub("index.sqlite"))
    }

    override func tearDown() {
        store?.close()
        store = nil
        tmp = nil
        super.tearDown()
    }

    func makeAgentDb(rows: Int) throws -> RawDB {
        let db = try RawDB(path: dbPath)
        try db.exec("""
            CREATE TABLE usage_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at INTEGER NOT NULL, provider TEXT NOT NULL,
              account_key TEXT NOT NULL, account_id TEXT, email TEXT, limit_id TEXT NOT NULL, label TEXT,
              window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER);
            CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, data TEXT);
            """)
        try db.run("INSERT INTO auth_credentials (provider, data) VALUES (?, ?)", [.text("anthropic"), .text(secret)])
        for i in 0..<rows {
            try db.run("""
                INSERT INTO usage_history (recorded_at, provider, account_key, account_id, email, limit_id, label,
                  window_label, used_fraction, status, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, [.integer(base + Int64(i) * 60000), .text("anthropic"), .text(accountKey), .text(accountId),
                      .text(email), .text("five_hour"), .text("5h"), .text("5 hours"), .real(0.1 + Double(i) / 100),
                      .text("allowed"), .integer(base + 3_600_000)])
        }
        return db
    }

    func importOnce() throws -> QuotaImportResult {
        return try QuotaReader.importQuotaSnapshots(store: store, key: key, agentDbPaths: [tmp.sub("missing.db"), dbPath])
    }

    func testImportIsIncrementalAndReadsOnlyAllowlistedColumns() throws {
        let db = try makeAgentDb(rows: 3)
        let first = try importOnce()
        XCTAssertEqual(first.status, "ok")
        XCTAssertEqual(first.added, 3)
        XCTAssertEqual(try importOnce().added, 0)

        // omp rewrites the latest row in place with a newer recorded_at.
        try db.run("UPDATE usage_history SET recorded_at = ?, used_fraction = ? WHERE id = 3",
                   [.integer(base + 10 * 60000), .real(0.5)])
        XCTAssertEqual(try importOnce().added, 1)
        try db.run("INSERT INTO usage_history (recorded_at, provider, account_key, limit_id, used_fraction) VALUES (?, ?, ?, ?, ?)",
                   [.integer(base + 20 * 60000), .text("anthropic"), .text(accountKey), .text("seven_day"), .null])
        XCTAssertEqual(try importOnce().added, 1)

        let snaps = try store.querySnapshots()
        XCTAssertEqual(snaps.count, 5)
        XCTAssertEqual(snaps[0].accountKey, Keyed.digest(key: key, domain: "account", value: "anthropic\u{0}" + accountKey))
        XCTAssertEqual(snaps[0].label, "5h")
        XCTAssertNil(snaps[4].usedFraction)
        XCTAssertNil(snaps[4].label)

        let metaKey = "quota_cursor:" + Keyed.digest(key: key, domain: "db", value: dbPath)
        let cursorText = try XCTUnwrap(try store.getMeta(metaKey))
        XCTAssertEqual(cursorText, "{\"id\":4,\"recordedAt\":\(base + 20 * 60000)}")

        store.close()
        assertNoSentinels(indexBytes(tmp.sub("index.sqlite")), [email, accountId, accountKey, secret])
    }

    func testMissingAndUnavailableSources() throws {
        let missing = try QuotaReader.importQuotaSnapshots(store: store, key: key, agentDbPaths: [tmp.sub("nope.db")])
        XCTAssertEqual(missing, QuotaImportResult(status: "missing", added: 0))

        let db = try RawDB(path: dbPath)
        try db.exec("CREATE TABLE usage_history (id INTEGER PRIMARY KEY, recorded_at INTEGER)")
        XCTAssertEqual(try importOnce().status, "unavailable")

        try writeFile(tmp.sub("agent/garbage.db"), "not a database at all, just synthetic bytes")
        let garbage = try QuotaReader.importQuotaSnapshots(store: store, key: key, agentDbPaths: [tmp.sub("agent/garbage.db")])
        XCTAssertEqual(garbage.status, "unavailable")
    }

    func testCursorFormatsMatchNode() {
        XCTAssertEqual(QuotaReader.parseCursor(nil), QuotaReader.Cursor(id: 0, recordedAt: -1))
        XCTAssertEqual(QuotaReader.parseCursor("12"), QuotaReader.Cursor(id: 12, recordedAt: -1))
        XCTAssertEqual(QuotaReader.parseCursor("{\"id\":3,\"recordedAt\":5.5}"), QuotaReader.Cursor(id: 3, recordedAt: 5.5))
        XCTAssertEqual(QuotaReader.parseCursor("{\"id\":-3,\"recordedAt\":5}"), QuotaReader.Cursor(id: 0, recordedAt: -1))
        XCTAssertEqual(QuotaReader.parseCursor("{\"id\":true,\"recordedAt\":5}"), QuotaReader.Cursor(id: 0, recordedAt: -1))
        XCTAssertEqual(QuotaReader.parseCursor("garbage"), QuotaReader.Cursor(id: 0, recordedAt: -1))
        XCTAssertEqual(QuotaReader.cursorText(7, -1), "{\"id\":7,\"recordedAt\":-1}")
        XCTAssertEqual(QuotaReader.cursorText(7, 1768470000000.5), "{\"id\":7,\"recordedAt\":1768470000000.5}")
    }
}

final class StoreTests: XCTestCase {
    func record(_ n: Int) -> RequestRecord {
        return RequestRecord(requestKey: "rk\(n)", ts: Double(1000 + n), provider: "p", api: "a", model: "m",
                             agentType: "main", purpose: "turn", sessionKey: "s", stopReason: "stop",
                             input: 1, output: 2, totalTokens: 3, durationMs: 10)
    }

    func testRoundTripModeAndDedupe() throws {
        let tmp = try TempDir()
        let path = tmp.sub("index.sqlite")
        let store = try Store(path: path)
        let cursor = FileCursor(dev: "1", ino: "2", size: 10, mtimeMs: 5.5, offset: 10, sessionKey: "s",
                                projectKey: nil, agentType: "main")
        XCTAssertEqual(try store.commitFile("fk", cursor: cursor, records: [record(1), record(2)]), 2)
        XCTAssertEqual(try store.commitFile("fk", cursor: cursor, records: [record(1), record(3)]), 1)
        XCTAssertEqual(try store.getCursor("fk"), cursor)
        XCTAssertNil(try store.getCursor("other"))
        let rows = try store.queryRequests(fromMs: 1002, toMs: 1004)
        XCTAssertEqual(rows.map { $0.requestKey }, ["rk2", "rk3"])
        XCTAssertEqual(rows[0], record(2))
        XCTAssertEqual(try store.counts(), StoreCounts(requests: 3, snapshots: 0, files: 1))
        try store.setMeta("k", "v")
        XCTAssertEqual(try store.getMeta("k"), "v")
        XCTAssertEqual(try store.getMeta("schema_version"), "1")
        store.close()

        var st = stat()
        let rc = stat(path, &st)
        XCTAssertEqual(rc, 0)
        XCTAssertEqual(Int(st.st_mode) & 0o777, 0o600)
    }

    func testRefusesNewerSchemaWithoutRewriting() throws {
        let tmp = try TempDir()
        let path = tmp.sub("index.sqlite")
        try Store(path: path).close()
        do {
            let raw = try RawDB(path: path)
            try raw.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'")
        }
        XCTAssertThrowsError(try Store(path: path)) { error in
            XCTAssertEqual(error as? TiboTattleError, TiboTattleError.storeNewer)
            XCTAssertEqual(String(describing: error), "store_newer")
        }
        do {
            let raw = try RawDB(path: path, readOnly: true)
            let rows = try raw.rows("SELECT value FROM meta WHERE key = 'schema_version'")
            XCTAssertEqual(rows.first?.first?.textValue, "2")
            try raw.exec("SELECT 1")
        }

        do {
            let raw = try RawDB(path: path)
            try raw.exec("UPDATE meta SET value = 'abc' WHERE key = 'schema_version'")
        }
        XCTAssertThrowsError(try Store(path: path)) { error in
            XCTAssertEqual(error as? TiboTattleError, TiboTattleError.storeNewer)
        }
    }

    func testOpensInWalMode() throws {
        let tmp = try TempDir()
        let path = tmp.sub("index.sqlite")
        try Store(path: path).close()
        let raw = try RawDB(path: path, readOnly: true)
        let rows = try raw.rows("PRAGMA journal_mode")
        XCTAssertEqual(rows.first?.first?.textValue?.lowercased(), "wal")
    }
}
