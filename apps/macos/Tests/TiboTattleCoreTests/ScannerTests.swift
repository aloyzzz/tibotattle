import Foundation
import XCTest
@testable import TiboTattleCore

final class ScannerTests: XCTestCase {
    let key = Data(repeating: 9, count: 32)
    let sessionId = "SESSIONSENTINEL0001"
    let cwd = "/synthetic/CWDSENTINEL/project-alpha"
    let prompt = "PROMPTSENTINELTEXT"
    let projectDir = "PROJDIRSENTINEL"

    var tmp: TempDir!
    var root: String!
    var store: Store!

    override func setUpWithError() throws {
        tmp = try TempDir()
        root = tmp.sub("sessions")
        try FileManager.default.createDirectory(atPath: root + "/" + projectDir, withIntermediateDirectories: true)
        store = try Store(path: tmp.sub("index.sqlite"))
    }

    override func tearDown() {
        store?.close()
        store = nil
        tmp = nil
        super.tearDown()
    }

    func header(_ id: String? = nil, cwd: String? = nil) -> String {
        return jsonLine(["type": "session", "id": id ?? sessionId, "timestamp": "2026-01-01T00:00:00.000Z",
                         "cwd": cwd ?? self.cwd])
    }

    func user(_ n: Int) -> String {
        return jsonLine(["type": "message", "id": "u\(n)", "timestamp": "2026-01-01T00:00:01.000Z",
                         "message": ["role": "user", "content": [["type": "text", "text": "\(prompt) \(cwd)"]]] as [String: Any]])
    }

    func turn(_ n: Int) -> String {
        let message: [String: Any] = [
            "role": "assistant",
            "content": [["type": "text", "text": prompt]] as [[String: String]],
            "api": "test-api",
            "provider": "prov",
            "model": "model-a",
            "usage": ["input": 10, "output": 20, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 30] as [String: Int],
            "stopReason": "stop",
            "timestamp": 1767225600000 + n,
            "duration": 1000,
            "ttft": 100,
        ]
        return jsonLine(["type": "message", "id": "a\(n)", "timestamp": "2026-01-01T00:00:02.000Z", "message": message])
    }

    func sessionFile(_ parts: String...) -> String {
        return ([root!, projectDir] + parts).joined(separator: "/")
    }

    func scan(maxLineBytes: Int = SessionScanner.defaultMaxLineBytes,
              labels: inout [String: String]) throws -> ScanResult {
        return try SessionScanner.scanSessions(store: store, key: key, sessionRoots: [root], maxLineBytes: maxLineBytes,
                                               labels: &labels)
    }

    func scan(maxLineBytes: Int = SessionScanner.defaultMaxLineBytes) throws -> ScanResult {
        var labels: [String: String] = [:]
        return try scan(maxLineBytes: maxLineBytes, labels: &labels)
    }

    func testIncrementalAppendAndUnchanged() throws {
        let file = sessionFile("s1.jsonl")
        try writeFile(file, header() + user(1) + turn(1) + turn(2))
        var labels: [String: String] = [:]
        let first = try scan(labels: &labels)
        XCTAssertEqual(first.filesSeen, 1)
        XCTAssertEqual(first.filesRead, 1)
        XCTAssertEqual(first.requestsAdded, 2)
        XCTAssertEqual(labels[Keyed.digest(key: key, domain: "project", value: cwd)], "project-alpha")

        let second = try scan()
        XCTAssertEqual(second.filesRead, 0)
        XCTAssertEqual(second.requestsAdded, 0)

        try appendFile(file, turn(3))
        let third = try scan()
        XCTAssertEqual(third.filesRead, 1)
        XCTAssertEqual(third.requestsAdded, 1)
        XCTAssertEqual(try store.counts().requests, 3)

        let rows = try store.queryRequests()
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0].sessionKey, Keyed.digest(key: key, domain: "session", value: sessionId))
        XCTAssertEqual(rows[2].projectKey, Keyed.digest(key: key, domain: "project", value: cwd))
        XCTAssertEqual(rows[0].agentType, "main")
        XCTAssertEqual(rows[0].ttftMs, 100)

        let cursor = try XCTUnwrap(try store.getCursor(Keyed.digest(key: key, domain: "file", value: file)))
        let size = try XCTUnwrap(try FileManager.default.attributesOfItem(atPath: file)[.size] as? NSNumber).intValue
        XCTAssertEqual(cursor.offset, size)
        XCTAssertEqual(cursor.size, size)
    }

    func testPartialLineWaitsForNewline() throws {
        let file = sessionFile("s1.jsonl")
        let t2 = turn(2)
        let cut = t2.index(t2.startIndex, offsetBy: 40)
        try writeFile(file, header() + turn(1) + String(t2[t2.startIndex..<cut]))
        XCTAssertEqual(try scan().requestsAdded, 1)
        try appendFile(file, String(t2[cut...]))
        XCTAssertEqual(try scan().requestsAdded, 1)
        XCTAssertEqual(try store.counts().requests, 2)
    }

    func testTruncationRereadsWithoutDoubleCounting() throws {
        let file = sessionFile("s1.jsonl")
        try writeFile(file, header() + turn(1) + turn(2) + turn(3))
        XCTAssertEqual(try scan().requestsAdded, 3)
        try writeFile(file, header() + turn(1))
        let again = try scan()
        XCTAssertEqual(again.filesRead, 1)
        XCTAssertEqual(again.requestsAdded, 0)
        try appendFile(file, turn(4))
        XCTAssertEqual(try scan().requestsAdded, 1)
        XCTAssertEqual(try store.counts().requests, 4)
    }

    func testBranchCopyDedupes() throws {
        try writeFile(sessionFile("s1.jsonl"), header() + turn(1) + turn(2))
        XCTAssertEqual(try scan().requestsAdded, 2)
        try writeFile(sessionFile("branch", "s2.jsonl"), header("SESSIONSENTINEL0002") + turn(1) + turn(2))
        let result = try scan()
        XCTAssertEqual(result.filesSeen, 2)
        XCTAssertEqual(result.filesRead, 1)
        XCTAssertEqual(result.requestsAdded, 0)
    }

    func testOversizedLineIsSkippedWithoutBuffering() throws {
        let big = jsonLine(["type": "message", "id": "big", "message": ["role": "user", "content": String(repeating: "x", count: 5000)] as [String: String]])
        try writeFile(sessionFile("s1.jsonl"), header() + big + turn(1) + big + turn(2))
        let result = try scan(maxLineBytes: 1024)
        XCTAssertEqual(result.linesSkipped, 2)
        XCTAssertEqual(result.requestsAdded, 2)
    }

    func testMalformedLinesAreIgnored() throws {
        try writeFile(sessionFile("s1.jsonl"), header() + "{not json\n" + "\n" + "[1,2]\n" + "\u{FEFF}{}\n" + turn(1))
        let result = try scan()
        XCTAssertEqual(result.requestsAdded, 1)
        XCTAssertEqual(result.linesSkipped, 0)
    }

    func testSymlinksAreNotFollowed() throws {
        let outside = tmp.sub("outside/real.jsonl")
        try writeFile(outside, header() + turn(1))
        try FileManager.default.createSymbolicLink(atPath: sessionFile("link.jsonl"), withDestinationPath: outside)
        try FileManager.default.createSymbolicLink(atPath: root + "/linkdir", withDestinationPath: tmp.sub("outside"))
        let result = try scan()
        XCTAssertEqual(result.filesSeen, 0)
        XCTAssertEqual(result.requestsAdded, 0)
    }

    func testDiscoveryOrderAndAgentTypes() throws {
        try writeFile(root + "/a/x.jsonl", header() + turn(1))
        try writeFile(root + "/a/b/y.jsonl", header() + turn(2))
        try writeFile(root + "/a/__advisor.1.jsonl", header() + turn(3))
        try writeFile(root + "/c.jsonl", header() + turn(4))
        try writeFile(root + "/a/notes.txt", "ignored")
        let files = SessionScanner.discoverSessionFiles([root, root])
        XCTAssertEqual(files.map { $0.relativeSegments.joined(separator: "/") },
                       ["c.jsonl", "a/__advisor.1.jsonl", "a/x.jsonl", "a/b/y.jsonl"])
        XCTAssertEqual(files.map { SessionRecord.classifyAgentType($0.relativeSegments) },
                       ["main", "advisor", "main", "subagent"])
        XCTAssertEqual(try scan().requestsAdded, 4)
        let types = try store.queryRequests().map { $0.agentType ?? "" }.sorted()
        XCTAssertEqual(types, ["advisor", "main", "main", "subagent"])
    }

    func testLabelRecoveredAfterRestart() throws {
        try writeFile(sessionFile("s1.jsonl"), header() + turn(1))
        _ = try scan()
        var labels: [String: String] = [:]
        let again = try scan(labels: &labels)
        XCTAssertEqual(again.filesRead, 0)
        XCTAssertEqual(labels[Keyed.digest(key: key, domain: "project", value: cwd)], "project-alpha")
    }

    func testIntermediateCommitsCoverLargeFiles() throws {
        var text = header()
        for n in 0..<5003 { text += turn(n) }
        try writeFile(sessionFile("big.jsonl"), text)
        XCTAssertEqual(try scan().requestsAdded, 5003)
        XCTAssertEqual(try scan().requestsAdded, 0)
        XCTAssertEqual(try store.counts().requests, 5003)
    }

    func testIndexHoldsNoContent() throws {
        try writeFile(sessionFile("s1.jsonl"), header() + user(1) + turn(1))
        _ = try scan()
        store.close()
        let bytes = indexBytes(tmp.sub("index.sqlite"))
        XCTAssertFalse(bytes.isEmpty)
        assertNoSentinels(bytes, [sessionId, "CWDSENTINEL", "project-alpha", prompt, projectDir, "s1.jsonl"])
    }
}
