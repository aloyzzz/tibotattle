// Fixed error codes, the local HMAC key and keyed digests (src/secret.js).

import CryptoKit
import Foundation

/// Every error the core throws carries a short fixed code (never a path,
/// input or SQLite message). `description` is the code itself.
public struct TiboTattleError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: String

    public init(_ code: String) {
        self.code = code
    }

    public var description: String { return code }

    public static let storeNewer = TiboTattleError("store_newer")
    public static let storeUnavailable = TiboTattleError("store_unavailable")
}

public enum Keyed {
    /// base64url(HMAC-SHA256(key, "tibotattle/<domain>/v1\0" + value)), first 22 chars.
    public static func digest(key: Data, domain: String, value: String) -> String {
        var hmac = HMAC<SHA256>(key: SymmetricKey(data: key))
        hmac.update(data: Data("tibotattle/\(domain)/v1\u{0}".utf8))
        hmac.update(data: Data(value.utf8))
        let mac = hmac.finalize()
        let base64 = Data(mac).base64EncodedString()
        let url = base64
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return String(url.prefix(22))
    }

    /// Lowercase or uppercase hex to bytes; nil for malformed input.
    public static func data(hex: String) -> Data? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = Data(capacity: chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x61...0x66: return c - 0x61 + 10
        case 0x41...0x46: return c - 0x41 + 10
        default: return nil
        }
    }
}

/// `<stateDir>/identity.key`: 32 random bytes, mode 0600, created exclusively.
public enum KeyFile {
    public static let fileName = "identity.key"
    public static let keyBytes = 32

    /// Returns the key, creating it once. Throws `key_invalid`,
    /// `key_unreadable` or `key_unwritable`.
    public static func loadOrCreate(stateDirectory: URL) throws -> Data {
        let path = PathUtil.join(PathUtil.resolve(stateDirectory.path), fileName)
        switch read(path) {
        case .ok(let key): return key
        case .invalid: throw TiboTattleError("key_invalid")
        case .unreadable: throw TiboTattleError("key_unreadable")
        case .missing: break
        }

        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, mode_t(0o600))
        if fd < 0 {
            if errno == EEXIST {
                if case .ok(let existing) = read(path) { return existing }
                throw TiboTattleError("key_invalid")
            }
            throw TiboTattleError("key_unwritable")
        }
        defer { close(fd) }
        var written = 0
        let ok: Bool = key.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard let base = raw.baseAddress else { return false }
            while written < raw.count {
                let n = write(fd, base + written, raw.count - written)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                written += n
            }
            return true
        }
        if !ok { throw TiboTattleError("key_unwritable") }
        return key
    }

    private enum ReadResult {
        case ok(Data)
        case missing
        case invalid
        case unreadable
    }

    private static func read(_ path: String) -> ReadResult {
        let fd = open(path, O_RDONLY | O_CLOEXEC)
        if fd < 0 {
            return errno == ENOENT ? .missing : .unreadable
        }
        defer { close(fd) }
        guard let data = PathUtil.readAll(fd: fd, limit: 4096) else { return .unreadable }
        return data.count == keyBytes ? .ok(data) : .invalid
    }
}
