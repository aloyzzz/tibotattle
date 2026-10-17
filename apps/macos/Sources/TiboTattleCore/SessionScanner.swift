// Session file discovery and bounded, incremental, replay-safe reading
// (src/omp/session-scanner.js).
//
// Only complete newline-terminated lines are consumed; the cursor is the byte
// offset just past the last complete line. Oversized lines are discarded while
// streaming, never buffered. Raw paths, cwd and session ids are digested before
// they reach the store; project labels live only in memory.

import Foundation

public struct DiscoveredFile: Sendable, Equatable {
    public var root: String
    public var path: String
    public var relativeSegments: [String]
}

public struct ScanResult: Sendable, Equatable {
    public var filesSeen: Int = 0
    public var filesRead: Int = 0
    public var requestsAdded: Int = 0
    public var linesSkipped: Int = 0
}

/// File identity as Node's bigint fstat reports it.
struct FileIdentity: Equatable {
    var dev: String
    var ino: String
    var size: Int
    var mtimeMs: Double
}

public enum SessionScanner {
    static let chunkBytes = 256 * 1024
    static let headerProbeBytes = 1024 * 1024
    static let commitBatch = 5000
    static let maxDepth = 16
    public static let defaultMaxLineBytes = 32 * 1024 * 1024

    static let modeMask = 0o170000
    static let modeDirectory = 0o040000
    static let modeRegular = 0o100000

    /// Regular *.jsonl files under each root, without following symlinks,
    /// in the same depth-first, UTF-16-sorted order as Node.
    public static func discoverSessionFiles(_ sessionRoots: [String], maxFiles: Int = 200000) -> [DiscoveredFile] {
        var found: [DiscoveredFile] = []
        var seen = Set<String>()
        for rawRoot in PathUtil.unique(sessionRoots) {
            let root = PathUtil.resolve(rawRoot)
            var rootStat = stat()
            guard lstat(root, &rootStat) == 0, Int(rootStat.st_mode) & modeMask == modeDirectory else { continue }
            var stack: [(dir: String, depth: Int, segments: [String])] = [(root, 0, [])]
            while !stack.isEmpty && found.count < maxFiles {
                let (dir, depth, segments) = stack.removeLast()
                guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
                let sorted = names.sorted { JSCompat.less($0, $1) }
                var subdirs: [(String, [String])] = []
                for name in sorted {
                    let full = PathUtil.join(dir, name)
                    var st = stat()
                    if lstat(full, &st) != 0 { continue }
                    let kind = Int(st.st_mode) & modeMask
                    if kind == modeDirectory {
                        if depth + 1 < maxDepth { subdirs.append((full, segments + [name])) }
                    } else if kind == modeRegular && JSCompat.hasUTF8Suffix(name, ".jsonl") && !seen.contains(full) {
                        seen.insert(full)
                        found.append(DiscoveredFile(root: root, path: full, relativeSegments: segments + [name]))
                        if found.count >= maxFiles { break }
                    }
                }
                for sub in subdirs.reversed() {
                    stack.append((sub.0, depth + 1, sub.1))
                }
            }
            if found.count >= maxFiles { break }
        }
        return found
    }

    /// Incrementally indexes every discovered session file. `labels` receives
    /// projectKey -> label (memory only), even when the scan throws part-way.
    public static func scanSessions(store: Store, key: Data, sessionRoots: [String],
                                    maxLineBytes: Int = defaultMaxLineBytes,
                                    labels: inout [String: String],
                                    isCancelled: () -> Bool = { false }) throws -> ScanResult {
        var totals = ScanResult()
        if isCancelled() { throw TiboTattleError("aborted") }
        let files = discoverSessionFiles(sessionRoots)
        totals.filesSeen = files.count
        for file in files {
            if isCancelled() { throw TiboTattleError("aborted") }
            try scanFile(file, store: store, key: key, maxLineBytes: maxLineBytes,
                         labels: &labels, totals: &totals, isCancelled: isCancelled)
        }
        return totals
    }

    static func cwdLabel(_ cwd: String) -> String? {
        let parts = cwd.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        let base = parts.last.map { String($0) } ?? cwd
        let label = JSCompat.utf16Prefix(base, 128)
        return label.isEmpty ? nil : label
    }

    /// JSON.parse of one line; nil when the line cannot be an object.
    static func parseLine(_ data: Data) -> Any? {
        if data.isEmpty { return nil }
        // Only objects matter. Requiring '{' first also keeps JSONSerialization
        // from guessing a UTF-16/32 encoding or skipping a BOM, which JSON.parse
        // would reject.
        guard let first = data.first(where: { $0 != 0x20 && $0 != 0x09 && $0 != 0x0D && $0 != 0x0A }),
              first == 0x7B else { return nil }
        if let parsed = try? JSONSerialization.jsonObject(with: data, options: []) {
            return parsed
        }
        // Node decodes the bytes as UTF-8 with replacement characters first.
        let repaired = Data(String(decoding: data, as: UTF8.self).utf8)
        if repaired != data, let parsed = try? JSONSerialization.jsonObject(with: repaired, options: []) {
            return parsed
        }
        return nil
    }

    static func identity(_ st: stat) -> FileIdentity {
        let dev = UInt64(bitPattern: Int64(st.st_dev))
        let ino = UInt64(st.st_ino)
        let sec = Int64(st.st_mtimespec.tv_sec)
        let nsec = Int64(st.st_mtimespec.tv_nsec)
        // Node: Number(stat.mtimeNs / 1000n) / 1000 (microsecond precision).
        let totalNs = sec &* 1_000_000_000 &+ nsec
        let micros = totalNs / 1000
        return FileIdentity(dev: String(dev), ino: String(ino), size: Int(st.st_size),
                            mtimeMs: Double(micros) / 1000)
    }

    /// pread that retries on EINTR; throws `read_failed`.
    static func readAt(_ fd: Int32, _ buffer: UnsafeMutableRawPointer, _ count: Int, _ offset: Int) throws -> Int {
        while true {
            let n = pread(fd, buffer, count, off_t(offset))
            if n >= 0 { return n }
            if errno == EINTR { continue }
            throw TiboTattleError("read_failed")
        }
    }

    /// Reads the first line (bounded) to rebuild the in-memory project label.
    static func recoverLabel(_ fd: Int32, key: Data, labels: inout [String: String]) throws {
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: headerProbeBytes, alignment: 16)
        defer { buffer.deallocate() }
        let bytesRead = try readAt(fd, buffer, headerProbeBytes, 0)
        guard bytesRead > 0, let nl = memchr(buffer, 0x0A, bytesRead) else { return }
        let end = UnsafeRawPointer(buffer).distance(to: UnsafeRawPointer(nl))
        let line = Data(bytes: buffer, count: end)
        guard let normalized = SessionRecord.normalizeEntry(parseLine(line), key: key),
              case .header(_, let cwd) = normalized, let dir = cwd else { return }
        if let label = cwdLabel(dir) {
            labels[Keyed.digest(key: key, domain: "project", value: dir)] = label
        }
    }

    static func scanFile(_ file: DiscoveredFile, store: Store, key: Data, maxLineBytes: Int,
                         labels: inout [String: String], totals: inout ScanResult,
                         isCancelled: () -> Bool) throws {
        let fileKey = Keyed.digest(key: key, domain: "file", value: file.path)
        let agentType = SessionRecord.classifyAgentType(file.relativeSegments)

        let fd = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 { return } // Vanished, became a symlink, or unreadable.
        defer { close(fd) }

        var st = stat()
        guard fstat(fd, &st) == 0 else { throw TiboTattleError("read_failed") }
        guard Int(st.st_mode) & modeMask == modeRegular else { return }
        let ident = identity(st)
        let cursor = try store.getCursor(fileKey)

        var offset = 0
        var sessionKey: String? = nil
        var projectKey: String? = nil
        if let c = cursor, c.dev == ident.dev, c.ino == ident.ino, ident.size >= c.offset {
            offset = c.offset
            sessionKey = c.sessionKey
            projectKey = c.projectKey
            let unchanged = ident.size == c.size && ident.mtimeMs == c.mtimeMs
            if (unchanged || offset > 0), let pk = projectKey, labels[pk] == nil {
                try recoverLabel(fd, key: key, labels: &labels)
            }
            if unchanged { return }
        }
        totals.filesRead += 1

        func cursorAt(_ consumed: Int, _ isFinal: Bool) -> FileCursor {
            // Intermediate commits record size = consumed so a restart never skips.
            return FileCursor(dev: ident.dev, ino: ident.ino, size: isFinal ? ident.size : consumed,
                              mtimeMs: ident.mtimeMs, offset: consumed, sessionKey: sessionKey,
                              projectKey: projectKey, agentType: agentType)
        }

        var records: [RequestRecord] = []
        var committed = offset
        var pending = Data()
        var discarding = false

        let buffer = UnsafeMutableRawPointer.allocate(byteCount: chunkBytes, alignment: 16)
        defer { buffer.deallocate() }
        let bytes = buffer.assumingMemoryBound(to: UInt8.self)

        var position = offset
        while position < ident.size {
            if isCancelled() { throw TiboTattleError("aborted") }
            let want = min(chunkBytes, ident.size - position)
            let bytesRead = try readAt(fd, buffer, want, position)
            if bytesRead == 0 { break }
            var start = 0
            while start < bytesRead {
                var newline = -1
                if let p = memchr(buffer + start, 0x0A, bytesRead - start) {
                    newline = UnsafeRawPointer(buffer).distance(to: UnsafeRawPointer(p))
                }
                let end = newline < 0 ? bytesRead : newline
                let segment = end - start
                if !discarding && pending.count + segment > maxLineBytes {
                    discarding = true
                    pending = Data()
                }
                if !discarding && segment > 0 {
                    pending.append(bytes + start, count: segment)
                }
                if end == bytesRead { break } // no newline in the rest of this chunk
                if discarding {
                    totals.linesSkipped += 1
                } else if let normalized = SessionRecord.normalizeEntry(
                    parseLine(pending), key: key, sessionKey: sessionKey,
                    projectKey: projectKey, agentType: agentType) {
                    switch normalized {
                    case .header(let sessionId, let cwd):
                        sessionKey = Keyed.digest(key: key, domain: "session", value: sessionId)
                        if let dir = cwd {
                            let pk = Keyed.digest(key: key, domain: "project", value: dir)
                            projectKey = pk
                            if let label = cwdLabel(dir) { labels[pk] = label }
                        } else {
                            projectKey = nil
                        }
                    case .request(let record):
                        records.append(record)
                    }
                }
                if pending.count > (1 << 20) {
                    pending = Data()
                } else {
                    pending.removeAll(keepingCapacity: true)
                }
                discarding = false
                committed = position + newline + 1
                start = newline + 1
                if records.count >= commitBatch {
                    totals.requestsAdded += try store.commitFile(fileKey, cursor: cursorAt(committed, false), records: records)
                    records.removeAll(keepingCapacity: true)
                }
            }
            position += bytesRead
        }
        totals.requestsAdded += try store.commitFile(fileKey, cursor: cursorAt(committed, true), records: records)
    }
}
