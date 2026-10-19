import Foundation
import XCTest

/// Static checks for the bundled dashboard (apps/web). No browser is started:
/// these guard the CSP contract (no inline code or styles, no external assets)
/// and the XSS rule (no HTML string injection) by reading the source files.
final class WebAssetsTests: XCTestCase {
    private var html = ""
    private var js = ""
    private var jsCode = ""
    private var css = ""
    private var favicon = ""

    override func setUpWithError() throws {
        let webRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // TiboTattleCoreTests
            .appendingPathComponent("../../../web")
            .standardizedFileURL
        func read(_ name: String) throws -> String {
            return try String(contentsOf: webRoot.appendingPathComponent(name), encoding: .utf8)
        }
        html = try read("index.html")
        js = try read("app.js")
        css = try read("styles.css")
        favicon = try read("favicon.svg")

        // Strip comments so prose cannot satisfy or trip the checks.
        let blockStripped = WebAssetsTests.regex(#"/\*.*?\*/"#, [.dotMatchesLineSeparators])
            .stringByReplacingMatches(in: js, options: [], range: WebAssetsTests.full(js), withTemplate: "")
        jsCode = WebAssetsTests.regex(##"(^|[^:'"`\\])//.*$"##, [.anchorsMatchLines])
            .stringByReplacingMatches(in: blockStripped, options: [],
                                      range: WebAssetsTests.full(blockStripped), withTemplate: "$1")
    }

    // MARK: helpers

    private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        // Patterns are literals in this file; a bad one is a test bug.
        return try! NSRegularExpression(pattern: pattern, options: options)
    }

    private static func full(_ text: String) -> NSRange {
        return NSRange(location: 0, length: (text as NSString).length)
    }

    private func has(_ pattern: String, in text: String, _ options: NSRegularExpression.Options = []) -> Bool {
        return WebAssetsTests.regex(pattern, options)
            .firstMatch(in: text, options: [], range: WebAssetsTests.full(text)) != nil
    }

    private func matches(_ pattern: String, in text: String,
                         _ options: NSRegularExpression.Options = []) -> [NSTextCheckingResult] {
        return WebAssetsTests.regex(pattern, options)
            .matches(in: text, options: [], range: WebAssetsTests.full(text))
    }

    private func group(_ result: NSTextCheckingResult, _ index: Int, in text: String) -> String {
        let range = result.range(at: index)
        if range.location == NSNotFound { return "" }
        return (text as NSString).substring(with: range)
    }

    // MARK: index.html

    func testIndexLoadsAppAsModuleAndStyles() {
        XCTAssertTrue(has(#"<script\s+type="module"\s+src="app\.js"></script>"#, in: html))
        XCTAssertTrue(has(#"<link\s+rel="stylesheet"\s+href="styles\.css">"#, in: html))
        XCTAssertTrue(has(#"<link\s+rel="icon"\s+href="favicon\.svg""#, in: html))
        XCTAssertTrue(has(#"<html lang="en">"#, in: html))
        XCTAssertTrue(has(#"<meta name="viewport""#, in: html))
    }

    func testIndexHasNoInlineScriptsStylesOrHandlers() {
        let scripts = matches(#"<script\b[^>]*>[\s\S]*?</script>"#, in: html, [.caseInsensitive])
        XCTAssertEqual(scripts.count, 1)
        for tag in scripts {
            let text = group(tag, 0, in: html)
            XCTAssertTrue(has(#"\bsrc="[^"]+""#, in: text), "every script must be external")
            XCTAssertTrue(has(#"></script>$"#, in: text), "script tags must be empty")
        }
        XCTAssertFalse(has(#"<style\b"#, in: html, [.caseInsensitive]))
        XCTAssertFalse(has(#"\sstyle\s*="#, in: html, [.caseInsensitive]))
        XCTAssertFalse(has(#"\son[a-z]+\s*="#, in: html, [.caseInsensitive]))
        XCTAssertFalse(has(#"javascript:"#, in: html, [.caseInsensitive]))
    }

    func testIndexReferencesNoExternalURLs() {
        let refs = matches(##"\b(?:src|href)\s*=\s*"([^"]*)""##, in: html, [.caseInsensitive])
            .map { group($0, 1, in: html) }
        XCTAssertFalse(refs.isEmpty)
        for ref in refs {
            XCTAssertFalse(has(#"^(?:[a-z][a-z0-9+.-]*:|//)"#, in: ref, [.caseInsensitive]),
                           "external reference: \(ref)")
        }
        XCTAssertFalse(has(#"https?://"#, in: html, [.caseInsensitive]))
    }

    func testIndexCSPMetaStaysStrict() throws {
        let found = matches(##"http-equiv="Content-Security-Policy"\s+content="([^"]+)""##, in: html)
        let first = try XCTUnwrap(found.first, "CSP meta present")
        let csp = group(first, 1, in: html)
        XCTAssertTrue(has(#"default-src 'self'"#, in: csp))
        XCTAssertTrue(has(#"script-src 'self'(;|$)"#, in: csp))
        XCTAssertTrue(has(#"style-src 'self'(;|$)"#, in: csp))
        XCTAssertFalse(has(#"unsafe-inline|unsafe-eval|\*"#, in: csp))
    }

    func testIndexProvidesNavigationForEveryRoute() {
        for route in ["overview", "usage", "performance", "allowance", "projects"] {
            XCTAssertTrue(has("href=\"#/\(route)\"", in: html), "nav link for \(route)")
            XCTAssertTrue(has("\\b\(route): \\{ title:", in: js), "route table entry for \(route)")
        }
        for period in ["24h", "7d", "30d", "all"] {
            XCTAssertTrue(has("data-period=\"\(period)\"", in: html), "period \(period)")
        }
        XCTAssertTrue(has(#"id="refresh-button""#, in: html))
        XCTAssertTrue(has(#"id="live-status""#, in: html))
    }

    // MARK: app.js

    func testAppNeverInjectsHTMLStringsOrEvaluatesCode() {
        let banned: [String] = [
            #"\.innerHTML\b"#, #"\.outerHTML\b"#, #"insertAdjacentHTML"#, #"document\.write"#,
            #"createContextualFragment"#, #"DOMParser"#, #"\beval\s*\("#, #"new\s+Function\s*\("#,
            ##"setTimeout\s*\(\s*['"`]"##, ##"setInterval\s*\(\s*['"`]"##,
        ]
        for pattern in banned {
            XCTAssertFalse(has(pattern, in: jsCode), "banned pattern \(pattern)")
        }
    }

    func testAppDoesNotSetInlineStyleAttributes() {
        XCTAssertFalse(has(##"setAttribute\(\s*['"`]style['"`]"##, in: jsCode))
        XCTAssertFalse(has(#"\.style\.cssText\b"#, in: jsCode))
        XCTAssertFalse(has(##"['"`]style['"`]\s*:"##, in: jsCode))
        XCTAssertFalse(has(#"\sstyle="#, in: jsCode))
    }

    func testAppMakesNoExternalRequests() {
        let urls = matches(##"[a-z][a-z0-9+.-]*://[^\s'"`)]+"##, in: jsCode, [.caseInsensitive])
            .map { group($0, 0, in: jsCode) }
            .filter { $0 != "http://www.w3.org/2000/svg" }
        XCTAssertEqual(urls, [])
        XCTAssertFalse(has(#"\bimport\s*\("#, in: jsCode))
        XCTAssertFalse(has(#"^\s*import\s"#, in: jsCode, [.anchorsMatchLines]))
        for call in matches(#"api\(\s*'([^']+)'"#, in: jsCode) {
            let path = group(call, 1, in: jsCode)
            XCTAssertTrue(has(#"^/api/[a-z]+$"#, in: path), "unexpected API path \(path)")
        }
    }

    func testAppFollowsTheAPIContract() {
        XCTAssertTrue(has(#"-new Date\(\)\.getTimezoneOffset\(\)"#, in: jsCode), "sends tz as minutes east of UTC")
        XCTAssertTrue(has(#"searchParams\.set\('tz'"#, in: jsCode))
        XCTAssertTrue(has(#"\['X-TiboTattle'\] = '1'"#, in: jsCode), "mutating requests carry the header")
        XCTAssertTrue(has(#"api\('/api/refresh', \{\}, \{ method: 'POST' \}\)"#, in: jsCode))
    }

    func testAppWorksUnderTheNativeScheme() {
        XCTAssertTrue(has(#"new URL\(path, window\.location\.href\)"#, in: jsCode),
                      "API URLs resolve against the page URL")
        XCTAssertFalse(has(#"location\.origin"#, in: jsCode), "origin is \"null\" for custom schemes")
        XCTAssertTrue(has(#"addEventListener\('tibotattle-change', scheduleRefetch\)"#, in: jsCode))
        XCTAssertTrue(has(#"setInterval\(pollStatus, POLL_MS\)"#, in: jsCode),
                      "polls /api/status when there is no event stream")
    }

    func testAppGuardsLocalStorageAccess() {
        let uses = matches(#"localStorage\.(getItem|setItem|removeItem)"#, in: jsCode)
        XCTAssertGreaterThanOrEqual(uses.count, 2)
        let ns = jsCode as NSString
        for use in uses {
            let start = max(0, use.range.location - 120)
            let before = ns.substring(with: NSRange(location: start, length: use.range.location - start))
            XCTAssertTrue(has(#"try\s*\{"#, in: before), "storage access must be inside try")
        }
    }

    // MARK: styles.css and favicon.svg

    func testStylesAreSelfContainedAndThemeAware() {
        XCTAssertFalse(has(#"@import"#, in: css))
        XCTAssertFalse(has(#"url\("#, in: css, [.caseInsensitive]))
        XCTAssertFalse(has(#"https?://"#, in: css, [.caseInsensitive]))
        XCTAssertTrue(has(#"@media \(prefers-color-scheme: dark\)"#, in: css))
        XCTAssertTrue(has(#"@media \(prefers-reduced-motion: reduce\)"#, in: css))
        XCTAssertTrue(has(#":focus-visible"#, in: css))
    }

    func testFaviconIsStatic() {
        XCTAssertTrue(has(##"^<svg xmlns="http://www\.w3\.org/2000/svg""##, in: favicon))
        XCTAssertFalse(has(#"<script|<style|<foreignObject|\son[a-z]+=|href=|xlink:"#, in: favicon, [.caseInsensitive]))
    }
}
