// omp source locations and the TiboTattle state directory.
// Path strings are built like POSIX path.resolve/path.join so keyed digests of
// paths stay stable (the original implementation at f140a49 used the same rules).

import Foundation

public struct OmpSources: Sendable, Equatable {
    public var agentDirs: [URL]
    public var sessionRoots: [URL]
    public var agentDbPaths: [URL]

    public init(agentDirs: [URL] = [], sessionRoots: [URL], agentDbPaths: [URL]) {
        self.agentDirs = agentDirs
        self.sessionRoots = sessionRoots
        self.agentDbPaths = agentDbPaths
    }

    /// `$PI_CODING_AGENT_DIR` (or `agentDir`), else `~/<$PI_CONFIG_DIR or .omp>/agent`.
    /// Existence is not required. (The Linux-only XDG location is not used on macOS.)
    public static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment,
                               home: URL = FileManager.default.homeDirectoryForCurrentUser,
                               agentDir: URL? = nil) -> OmpSources {
        let homePath = PathUtil.resolve(home.path)
        var dirs: [String] = []
        let overridden = PathUtil.nonEmpty(agentDir?.path) ?? PathUtil.nonEmpty(environment["PI_CODING_AGENT_DIR"])
        if let overridden = overridden {
            dirs.append(PathUtil.resolve(PathUtil.expandHome(overridden, home: homePath)))
        } else {
            let configDir = PathUtil.nonEmpty(environment["PI_CONFIG_DIR"]) ?? ".omp"
            dirs.append(PathUtil.resolve(PathUtil.join(configDir, "agent"), base: homePath))
        }
        let unique = PathUtil.unique(dirs)
        let roots = PathUtil.unique(unique.map { PathUtil.join($0, "sessions") })
        let dbs = PathUtil.unique(unique.map { PathUtil.join($0, "agent.db") })
        return OmpSources(
            agentDirs: unique.map { URL(fileURLWithPath: $0) },
            sessionRoots: roots.map { URL(fileURLWithPath: $0) },
            agentDbPaths: dbs.map { URL(fileURLWithPath: $0) }
        )
    }
}

public enum StatePaths {
    public static let indexFileName = "index.sqlite"

    /// `$TIBOTATTLE_STATE_DIR`, else `~/Library/Application Support/TiboTattle`.
    public static func defaultDirectory(environment: [String: String],
                                        home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        let homePath = PathUtil.resolve(home.path)
        if let overridden = PathUtil.nonEmpty(environment["TIBOTATTLE_STATE_DIR"]) {
            return URL(fileURLWithPath: PathUtil.resolve(PathUtil.expandHome(overridden, home: homePath)))
        }
        return URL(fileURLWithPath: PathUtil.join(PathUtil.join(PathUtil.join(homePath, "Library"), "Application Support"), "TiboTattle"))
    }

    /// mkdir -p with mode 0700 for created directories. Throws `state_dir_unavailable`.
    @discardableResult
    public static func ensureDirectory(_ url: URL) throws -> URL {
        let path = PathUtil.resolve(url.path)
        do {
            try FileManager.default.createDirectory(
                atPath: path, withIntermediateDirectories: true,
                attributes: [FileAttributeKey.posixPermissions: NSNumber(value: Int16(0o700))])
        } catch {
            throw TiboTattleError("state_dir_unavailable")
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else {
            throw TiboTattleError("state_dir_unavailable")
        }
        return URL(fileURLWithPath: path)
    }
}

/// POSIX path helpers (path.posix semantics, kept so path digests stay stable).
enum PathUtil {
    static func nonEmpty(_ value: String?) -> String? {
        guard let value = value else { return nil }
        return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
    }

    static func expandHome(_ value: String, home: String) -> String {
        if value == "~" { return home }
        if value.hasPrefix("~/") { return join(home, String(value.dropFirst(2))) }
        return value
    }

    static func unique(_ list: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for item in list where !seen.contains(item) {
            seen.insert(item)
            out.append(item)
        }
        return out
    }

    /// path.posix.join for two segments.
    static func join(_ a: String, _ b: String) -> String {
        if a.isEmpty { return normalize(b) }
        if b.isEmpty { return normalize(a) }
        return normalize(a + "/" + b)
    }

    /// path.posix.resolve(base, p): absolute, normalized, no trailing slash.
    static func resolve(_ p: String, base: String? = nil) -> String {
        if p.hasPrefix("/") { return normalize(p) }
        let b = base ?? FileManager.default.currentDirectoryPath
        let absBase = b.hasPrefix("/") ? b : "/" + b
        return normalize(absBase + "/" + p)
    }

    /// path.posix.normalize, minus the trailing-slash preservation (callers
    /// only pass results to resolve/join, which drop it for absolute paths).
    static func normalize(_ p: String) -> String {
        if p.isEmpty { return "." }
        let absolute = p.hasPrefix("/")
        var parts: [Substring] = []
        for seg in p.split(separator: "/", omittingEmptySubsequences: true) {
            if seg == "." { continue }
            if seg == ".." {
                if let last = parts.last, last != ".." {
                    parts.removeLast()
                } else if !absolute {
                    parts.append(seg)
                }
                continue
            }
            parts.append(seg)
        }
        let body = parts.joined(separator: "/")
        if absolute { return "/" + body }
        return body.isEmpty ? "." : body
    }

    /// Reads a whole descriptor (bounded); nil on read error or overflow.
    static func readAll(fd: Int32, limit: Int) -> Data? {
        var out = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = buffer.withUnsafeMutableBytes { raw -> Int in
                return read(fd, raw.baseAddress, raw.count)
            }
            if n < 0 {
                if errno == EINTR { continue }
                return nil
            }
            if n == 0 { break }
            out.append(contentsOf: buffer[0..<n])
            if out.count > limit { return nil }
        }
        return out
    }
}
