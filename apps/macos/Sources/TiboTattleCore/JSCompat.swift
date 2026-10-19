// JavaScript semantics that the original (retired) implementation at f140a49
// used, reproduced exactly because digests, index values and API bodies depend on them:
// UTF-16 string ordering, Math.round, Number#toString, Number.isSafeInteger,
// Date.parse (ISO formats) and Date#toISOString day keys.

import Foundation

enum JSCompat {
    static let maxSafeInteger: Double = 9007199254740991
    static let maxTimeValue: Double = 8.64e15

    // MARK: Strings

    /// `a < b` for JavaScript strings (UTF-16 code unit order).
    static func less(_ a: String, _ b: String) -> Bool {
        return a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    /// -1, 0 or 1 by UTF-16 code unit order; equality is code-unit equality.
    static func compare(_ a: String, _ b: String) -> Int {
        if less(a, b) { return -1 }
        if less(b, a) { return 1 }
        return 0
    }

    /// cmpStr from the analysis modules: null/undefined compare as ''.
    static func compareNullable(_ a: String?, _ b: String?) -> Int {
        return compare(a ?? "", b ?? "")
    }

    /// `s.slice(0, n)` (UTF-16 code units).
    static func utf16Prefix(_ s: String, _ n: Int) -> String {
        let units = s.utf16
        if units.count <= n { return s }
        return String(decoding: Array(units.prefix(n)), as: UTF16.self)
    }

    static func hasUTF8Suffix(_ s: String, _ suffix: String) -> Bool {
        let a = Array(s.utf8)
        let b = Array(suffix.utf8)
        if a.count < b.count { return false }
        return Array(a[(a.count - b.count)...]) == b
    }

    // MARK: Numbers

    /// Math.round: round half toward +Infinity.
    static func round(_ x: Double) -> Double {
        if !x.isFinite { return x }
        let f = x.rounded(.down)
        return (x - f >= 0.5) ? f + 1 : f
    }

    static func isSafeInteger(_ x: Double) -> Bool {
        return x.isFinite && x.rounded(.towardZero) == x && abs(x) <= maxSafeInteger
    }

    static func intIfIntegral(_ x: Double) -> Int? {
        guard x.isFinite, x.rounded(.towardZero) == x, abs(x) < 9.2e18 else { return nil }
        return Int(x)
    }

    /// Converts an exact sum (kept as Double like JavaScript) back to Int.
    static func intFromSum(_ x: Double?) -> Int? {
        guard let x = x else { return nil }
        return intIfIntegral(x)
    }

    /// ECMAScript Number::toString(10) for finite and non-finite doubles.
    static func numberString(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value == 0 { return "0" }
        let negative = value < 0
        // Swift's description is the shortest round-tripping decimal; only the
        // layout differs from JavaScript, so re-layout its digits.
        let desc = "\(abs(value))"
        var mantissa = desc
        var exponent = 0
        if let eIndex = desc.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(desc[desc.startIndex..<eIndex])
            exponent = Int(String(desc[desc.index(after: eIndex)...])) ?? 0
        }
        var intPart = mantissa
        var fracPart = ""
        if let dot = mantissa.firstIndex(of: ".") {
            intPart = String(mantissa[mantissa.startIndex..<dot])
            fracPart = String(mantissa[mantissa.index(after: dot)...])
        }
        var digits: [Character] = Array(intPart + fracPart)
        var n = intPart.count + exponent // value = 0.d1d2d3... * 10^n
        while digits.count > 1 && digits[0] == "0" {
            digits.removeFirst()
            n -= 1
        }
        while digits.count > 1 && digits[digits.count - 1] == "0" {
            digits.removeLast()
        }
        let k = digits.count
        let ds = String(digits)
        var out: String
        if k <= n && n <= 21 {
            out = ds + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let head = String(digits[0..<n])
            let tail = String(digits[n...])
            out = head + "." + tail
        } else if -6 < n && n <= 0 {
            out = "0." + String(repeating: "0", count: -n) + ds
        } else {
            let e = n - 1
            let es = e < 0 ? "-" + String(-e) : "+" + String(e)
            if k == 1 {
                out = ds + "e" + es
            } else {
                out = String(digits[0]) + "." + String(digits[1...]) + "e" + es
            }
        }
        if negative { out = "-" + out }
        return out
    }

    /// `Number(text)` for the forms SQLite text can hold (decimal, hex, Infinity).
    static func numberFromString(_ text: String?) -> Double {
        guard let text = text else { return 0 }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }
        if trimmed == "Infinity" || trimmed == "+Infinity" { return .infinity }
        if trimmed == "-Infinity" { return -.infinity }
        let bytes = Array(trimmed.utf8)
        if bytes.count > 2 && bytes[0] == 0x30 && (bytes[1] == 0x78 || bytes[1] == 0x58) {
            var v: Double = 0
            for b in bytes[2...] {
                let digit: Int
                switch b {
                case 0x30...0x39: digit = Int(b) - 0x30
                case 0x61...0x66: digit = Int(b) - 0x61 + 10
                case 0x41...0x46: digit = Int(b) - 0x41 + 10
                default: return .nan
                }
                v = v * 16 + Double(digit)
            }
            return v
        }
        // Decimal literal: [+-] digits [. digits] [e [+-] digits]
        var i = 0
        if i < bytes.count && (bytes[i] == 0x2B || bytes[i] == 0x2D) { i += 1 }
        var sawDigit = false
        while i < bytes.count && bytes[i] >= 0x30 && bytes[i] <= 0x39 { i += 1; sawDigit = true }
        if i < bytes.count && bytes[i] == 0x2E {
            i += 1
            while i < bytes.count && bytes[i] >= 0x30 && bytes[i] <= 0x39 { i += 1; sawDigit = true }
        }
        if !sawDigit { return .nan }
        if i < bytes.count && (bytes[i] == 0x65 || bytes[i] == 0x45) {
            i += 1
            if i < bytes.count && (bytes[i] == 0x2B || bytes[i] == 0x2D) { i += 1 }
            var expDigit = false
            while i < bytes.count && bytes[i] >= 0x30 && bytes[i] <= 0x39 { i += 1; expDigit = true }
            if !expDigit { return .nan }
        }
        if i != bytes.count { return .nan }
        return Double(trimmed) ?? .nan
    }

    // MARK: Dates

    static let msPerDay: Int64 = 86_400_000

    /// Days since 1970-01-01 for a proleptic Gregorian date (month 1...12).
    static func daysFromCivil(_ year: Int64, _ month: Int64, _ day: Int64) -> Int64 {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    static func civilFromDays(_ days: Int64) -> (year: Int64, month: Int64, day: Int64) {
        let z = days + 719468
        let era = (z >= 0 ? z : z - 146096) / 146097
        let doe = z - era * 146097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        return (m <= 2 ? y + 1 : y, m, d)
    }

    static func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
        let q = a / b
        return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q
    }

    private static func pad(_ v: Int64, _ width: Int) -> String {
        let s = String(v)
        return s.count >= width ? s : String(repeating: "0", count: width - s.count) + s
    }

    /// `new Date(t).toISOString().slice(0, 10)`; nil where JavaScript throws.
    static func isoDayPrefix(_ t: Double) -> String? {
        guard t.isFinite, abs(t) <= maxTimeValue else { return nil }
        let tv = Int64(t.rounded(.towardZero))
        let days = floorDiv(tv, msPerDay)
        let (y, m, d) = civilFromDays(days)
        let year: String
        if y >= 0 && y <= 9999 {
            year = pad(y, 4)
        } else {
            year = (y < 0 ? "-" : "+") + pad(abs(y), 6)
        }
        let full = year + "-" + pad(m, 2) + "-" + pad(d, 2)
        return String(full.prefix(10))
    }

    /// Date.parse for the ECMAScript date-time string format (and the common
    /// V8 relaxations: lowercase t/z, a space separator, +HHmm offsets, any
    /// number of fraction digits). Date-only forms are UTC; date-times without
    /// an offset are local time. Other formats return nil.
    static func dateParse(_ text: String) -> Double? {
        let b = Array(text.utf8)
        var i = 0
        func isDigit(_ idx: Int) -> Bool { return idx < b.count && b[idx] >= 0x30 && b[idx] <= 0x39 }
        func readDigits(_ count: Int) -> Int64? {
            guard i + count <= b.count else { return nil }
            var v: Int64 = 0
            for k in 0..<count {
                guard isDigit(i + k) else { return nil }
                v = v * 10 + Int64(b[i + k] - 0x30)
            }
            i += count
            return v
        }

        let year: Int64
        if i < b.count && (b[i] == 0x2B || b[i] == 0x2D) {
            let negative = b[i] == 0x2D
            i += 1
            guard let y = readDigits(6) else { return nil }
            if negative && y == 0 { return nil }
            year = negative ? -y : y
        } else {
            guard let y = readDigits(4) else { return nil }
            year = y
        }
        var month: Int64 = 1
        var day: Int64 = 1
        if i < b.count && b[i] == 0x2D {
            i += 1
            guard let m = readDigits(2) else { return nil }
            month = m
            if i < b.count && b[i] == 0x2D {
                i += 1
                guard let d = readDigits(2) else { return nil }
                day = d
            }
        }
        guard month >= 1 && month <= 12 && day >= 1 && day <= 31 else { return nil }

        var hasTime = false
        var hour: Int64 = 0
        var minute: Int64 = 0
        var second: Int64 = 0
        var millis: Int64 = 0
        var offsetMinutes: Int64? = nil
        if i < b.count && (b[i] == 0x54 || b[i] == 0x74 || b[i] == 0x20) {
            i += 1
            hasTime = true
            guard let h = readDigits(2) else { return nil }
            guard i < b.count && b[i] == 0x3A else { return nil }
            i += 1
            guard let mi = readDigits(2) else { return nil }
            hour = h
            minute = mi
            if i < b.count && b[i] == 0x3A {
                i += 1
                guard let s = readDigits(2) else { return nil }
                second = s
                if i < b.count && b[i] == 0x2E {
                    i += 1
                    guard isDigit(i) else { return nil }
                    var digits = 0
                    var frac: Int64 = 0
                    while isDigit(i) {
                        if digits < 3 {
                            frac = frac * 10 + Int64(b[i] - 0x30)
                        }
                        digits += 1
                        i += 1
                    }
                    var scaled = frac
                    var have = min(digits, 3)
                    while have < 3 {
                        scaled *= 10
                        have += 1
                    }
                    millis = scaled
                }
            }
            if i < b.count && (b[i] == 0x5A || b[i] == 0x7A) {
                i += 1
                offsetMinutes = 0
            } else if i < b.count && (b[i] == 0x2B || b[i] == 0x2D) {
                let sign: Int64 = b[i] == 0x2D ? -1 : 1
                i += 1
                guard let oh = readDigits(2) else { return nil }
                if i < b.count && b[i] == 0x3A { i += 1 }
                guard let om = readDigits(2) else { return nil }
                guard oh <= 23 && om <= 59 else { return nil }
                offsetMinutes = sign * (oh * 60 + om)
            }
        }
        guard i == b.count else { return nil }
        guard minute <= 59 && second <= 59 else { return nil }
        if hour == 24 {
            guard minute == 0 && second == 0 && millis == 0 else { return nil }
        } else if hour > 24 {
            return nil
        }

        let days = daysFromCivil(year, month, 1) + (day - 1)
        var ms = days * msPerDay + hour * 3_600_000 + minute * 60_000 + second * 1000 + millis
        if hasTime {
            if let off = offsetMinutes {
                ms -= off * 60_000
            } else {
                ms = localToUTC(ms)
            }
        }
        let value = Double(ms)
        guard abs(value) <= maxTimeValue else { return nil }
        return value
    }

    /// Interprets a wall-clock time (ms, as if UTC) in the current time zone.
    private static func localToUTC(_ localMs: Int64) -> Int64 {
        let tz = TimeZone.current
        let guess = Date(timeIntervalSince1970: Double(localMs) / 1000)
        let off1 = Int64(tz.secondsFromGMT(for: guess)) * 1000
        var utc = localMs - off1
        let off2 = Int64(tz.secondsFromGMT(for: Date(timeIntervalSince1970: Double(utc) / 1000))) * 1000
        if off2 != off1 {
            utc = localMs - off2
        }
        return utc
    }
}
