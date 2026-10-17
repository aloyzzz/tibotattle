// Ordered JSON values and a serializer that matches JavaScript's
// JSON.stringify: explicit nulls, insertion-ordered keys and ECMAScript
// Number#toString formatting, so API bodies equal what src/server.js sends.

import Foundation

public struct JSONField: Equatable, Sendable {
    public let key: String
    public let value: JSONValue

    public init(_ key: String, _ value: JSONValue) {
        self.key = key
        self.value = value
    }
}

public enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([JSONField])
}

// MARK: - Construction helpers

extension JSONValue {
    static func jStr(_ value: String?) -> JSONValue {
        guard let value = value else { return .null }
        return .string(value)
    }

    static func jNum(_ value: Double?) -> JSONValue {
        guard let value = value else { return .null }
        return .number(value)
    }

    static func jInt(_ value: Int?) -> JSONValue {
        guard let value = value else { return .null }
        return .number(Double(value))
    }

    static func jBool(_ value: Bool?) -> JSONValue {
        guard let value = value else { return .null }
        return .bool(value)
    }

    /// Converts a JSONSerialization result (NSNull, NSNumber, NSString,
    /// NSArray, NSDictionary) into a JSONValue. Booleans stay booleans.
    /// Dictionary keys are sorted because NSDictionary has no order.
    public init(any: Any?) {
        guard let any = any else {
            self = .null
            return
        }
        if any is NSNull {
            self = .null
            return
        }
        if let s = any as? String {
            self = .string(s)
            return
        }
        if let n = any as? NSNumber {
            if JSONValue.isBoolean(n) {
                self = .bool(n.boolValue)
            } else {
                self = .number(n.doubleValue)
            }
            return
        }
        if let a = any as? [Any] {
            self = .array(a.map { JSONValue(any: $0) })
            return
        }
        if let d = any as? [String: Any] {
            let keys = d.keys.sorted { JSCompat.less($0, $1) }
            self = .object(keys.map { JSONField($0, JSONValue(any: d[$0])) })
            return
        }
        self = .null
    }

    /// Parses UTF-8 JSON text (any top-level value).
    public static func parse(_ data: Data) -> JSONValue? {
        guard let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return nil
        }
        return JSONValue(any: any)
    }

    /// True for NSNumber instances that JSONSerialization created from
    /// `true`/`false` (CFBoolean), which must never be treated as numbers.
    static func isBoolean(_ n: NSNumber) -> Bool {
        return CFGetTypeID(n as CFTypeRef) == CFBooleanGetTypeID()
    }
}

// MARK: - Reading helpers (lenient; wrong types read as nil)

extension JSONValue {
    /// Value for `key` (the last one wins, like JSON.parse); `.null` if absent.
    public subscript(_ key: String) -> JSONValue {
        if case .object(let fields) = self {
            var found: JSONValue = .null
            for field in fields where field.key == key {
                found = field.value
            }
            return found
        }
        return .null
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// Finite numbers only.
    public var doubleValue: Double? {
        if case .number(let d) = self, d.isFinite { return d }
        return nil
    }

    /// Integral finite numbers that fit in Int.
    public var intValue: Int? {
        guard let d = doubleValue else { return nil }
        return JSCompat.intIfIntegral(d)
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var objectFields: [JSONField]? {
        if case .object(let f) = self { return f }
        return nil
    }
}

// MARK: - Serialization (JSON.stringify compatible)

extension JSONValue {
    /// Compact JSON text, byte-compatible with JSON.stringify for the same value.
    public func serialized() -> String {
        var out = ""
        write(into: &out)
        return out
    }

    public func serializedData() -> Data {
        return Data(serialized().utf8)
    }

    func write(into out: inout String) {
        switch self {
        case .null:
            out += "null"
        case .bool(let b):
            out += b ? "true" : "false"
        case .number(let d):
            out += d.isFinite ? JSCompat.numberString(d) : "null"
        case .string(let s):
            JSONValue.writeString(s, into: &out)
        case .array(let items):
            out += "["
            var first = true
            for item in items {
                if !first { out += "," }
                first = false
                item.write(into: &out)
            }
            out += "]"
        case .object(let fields):
            out += "{"
            var first = true
            for field in fields {
                if !first { out += "," }
                first = false
                JSONValue.writeString(field.key, into: &out)
                out += ":"
                field.value.write(into: &out)
            }
            out += "}"
        }
    }

    static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

// MARK: - Codable bridge

public struct JSONCodingKey: CodingKey {
    public var stringValue: String
    public var intValue: Int?

    public init(_ string: String) {
        self.stringValue = string
        self.intValue = nil
    }

    public init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    public init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        if let keyed = try? decoder.container(keyedBy: JSONCodingKey.self) {
            var fields: [JSONField] = []
            let keys = keyed.allKeys.sorted { JSCompat.less($0.stringValue, $1.stringValue) }
            for k in keys {
                let value = try keyed.decode(JSONValue.self, forKey: k)
                fields.append(JSONField(k.stringValue, value))
            }
            self = .object(fields)
            return
        }
        if var unkeyed = try? decoder.unkeyedContainer() {
            var items: [JSONValue] = []
            while !unkeyed.isAtEnd {
                items.append(try unkeyed.decode(JSONValue.self))
            }
            self = .array(items)
            return
        }
        let single = try decoder.singleValueContainer()
        if single.decodeNil() {
            self = .null
        } else if let b = try? single.decode(Bool.self) {
            self = .bool(b)
        } else if let d = try? single.decode(Double.self) {
            self = .number(d)
        } else if let s = try? single.decode(String.self) {
            self = .string(s)
        } else {
            throw DecodingError.dataCorruptedError(in: single, debugDescription: "unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .null:
            var c = encoder.singleValueContainer()
            try c.encodeNil()
        case .bool(let b):
            var c = encoder.singleValueContainer()
            try c.encode(b)
        case .number(let d):
            var c = encoder.singleValueContainer()
            if d.isFinite {
                try c.encode(d)
            } else {
                try c.encodeNil()
            }
        case .string(let s):
            var c = encoder.singleValueContainer()
            try c.encode(s)
        case .array(let items):
            var c = encoder.unkeyedContainer()
            for item in items {
                try c.encode(item)
            }
        case .object(let fields):
            var c = encoder.container(keyedBy: JSONCodingKey.self)
            for field in fields {
                try c.encode(field.value, forKey: JSONCodingKey(field.key))
            }
        }
    }
}

/// Types whose JSON form is defined by an ordered JSONValue. Codable
/// conformances are written per type on top of `json` and `init(json:)` so
/// `null` is always encoded explicitly.
public protocol JSONRepresentable {
    var json: JSONValue { get }
    init(json: JSONValue)
}
