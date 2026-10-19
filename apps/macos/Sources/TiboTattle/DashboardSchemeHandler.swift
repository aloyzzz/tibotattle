// Serves the apps/web dashboard and its JSON API on tibotattle://app/ without
// any HTTP server or socket.
//
// - Static files come from a fixed allowlist inside the bundle's
//   Resources/web directory; request paths are never joined onto the
//   filesystem.
// - /api/* is answered in-process by APIRouter on a background queue.
//   /api/events (server-sent events) does not exist here; the dashboard falls
//   back to polling /api/status and to the `tibotattle-change` event.
// - Every response carries the security headers in `securityHeaders`.
// - WebKit may stop a task at any time; a stopped task never receives
//   another callback.

import Foundation
import TiboTattleCore
import WebKit

@MainActor
final class DashboardSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "tibotattle"
    static let host = "app"
    static let startURL = URL(string: "tibotattle://app/")!

    static let csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

    static let securityHeaders: [String: String] = [
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cross-Origin-Opener-Policy": "same-origin",
    ]

    /// URL path -> (file name inside Resources/web, content type).
    static let staticFiles: [String: (file: String, type: String)] = [
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/styles.css": ("styles.css", "text/css; charset=utf-8"),
        "/favicon.svg": ("favicon.svg", "image/svg+xml"),
    ]

    /// GET routes whose query APIRouter validates (parseQuery).
    static let queryRoutes: Set<String> = ["/api/status", "/api/usage", "/api/performance", "/api/allowance", "/api/overview"]

    static func isAppURL(_ url: URL?) -> Bool {
        guard let url = url else { return false }
        return url.scheme?.lowercased() == scheme && url.host?.lowercased() == host && url.port == nil
            && url.user == nil && url.password == nil
    }

    private let engine: Engine
    private let webRoot: URL?
    private let onRefreshed: () -> Void
    private let apiQueue = DispatchQueue(label: "io.github.aloyzzz.tibotattle.api", qos: .userInitiated)

    /// Tasks WebKit started and has not stopped, keyed by a never-reused token.
    private var live: [Int: WKURLSchemeTask] = [:]
    private var nextToken = 0
    private var invalidated = false

    init(engine: Engine, webRoot: URL?, onRefreshed: @escaping () -> Void) {
        self.engine = engine
        self.webRoot = webRoot
        self.onRefreshed = onRefreshed
        super.init()
    }

    /// Called when the dashboard window closes: drop every pending reply.
    func invalidate() {
        invalidated = true
        live.removeAll()
    }

    // MARK: WKURLSchemeHandler

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let token = nextToken
        nextToken += 1
        live[token] = urlSchemeTask

        let request = urlSchemeTask.request
        let method = (request.httpMethod ?? "GET").uppercased()
        guard let url = request.url, Self.isAppURL(url),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            replyError(token, status: 404, code: "not_found", url: request.url ?? Self.startURL, method: method)
            return
        }
        let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath

        if let entry = Self.staticFiles[path] {
            guard method == "GET" || method == "HEAD" else {
                replyError(token, status: 405, code: "method_not_allowed", url: url, method: method, allow: "GET, HEAD")
                return
            }
            serveStatic(token, file: entry.file, type: entry.type, url: url, method: method)
            return
        }

        // APIRouter owns method checks, the X-TiboTattle header on
        // /api/refresh and fixed error bodies for every other /api/ path.
        guard path.hasPrefix("/api/"), path != "/api/events" else {
            replyError(token, status: 404, code: "not_found", url: url, method: method)
            return
        }
        routeAPI(token, method: method, path: path, components: components, request: request, url: url)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let stopped = urlSchemeTask as AnyObject
        for (token, task) in live where (task as AnyObject) === stopped {
            live[token] = nil
        }
    }

    // MARK: Routing

    private func serveStatic(_ token: Int, file: String, type: String, url: URL, method: String) {
        guard let root = webRoot else {
            replyError(token, status: 404, code: "not_found", url: url, method: method)
            return
        }
        let fileURL = root.appendingPathComponent(file, isDirectory: false)
        apiQueue.async {
            let body = try? Data(contentsOf: fileURL)
            Task { @MainActor [weak self] in
                guard let self = self else { return }
                if let body = body {
                    self.reply(token, status: 200, contentType: type, body: body, cacheControl: "no-cache",
                               url: url, method: method)
                } else {
                    self.replyError(token, status: 404, code: "not_found", url: url, method: method)
                }
            }
        }
    }

    private func routeAPI(_ token: Int, method: String, path: String, components: URLComponents,
                          request: URLRequest, url: URL) {
        // A repeated period, tz or tier parameter is rejected with 400.
        var query: [String: String] = [:]
        var duplicate: String?
        for item in components.percentEncodedQueryItems ?? [] {
            let name = Self.decode(item.name)
            let value = Self.decode(item.value ?? "")
            if query[name] != nil {
                switch name {
                case "period": duplicate = duplicate ?? "bad_period"
                case "tz": duplicate = duplicate ?? "bad_tz"
                case "tier": duplicate = duplicate ?? "bad_tier"
                default: break
                }
            } else {
                query[name] = value
            }
        }
        if let code = duplicate, method == "GET", Self.queryRoutes.contains(path) {
            replyError(token, status: 400, code: code, url: url, method: method)
            return
        }

        // Pass headers under their original and lower-cased names.
        var headers: [String: String] = [:]
        for (name, value) in request.allHTTPHeaderFields ?? [:] {
            headers[name] = value
            headers[name.lowercased()] = value
        }

        let engine = self.engine
        let finalQuery = query
        let finalHeaders = headers
        apiQueue.async {
            let response = APIRouter.handle(method: method, path: path, query: finalQuery, headers: finalHeaders,
                                            engine: engine, now: Date())
            Task { @MainActor [weak self] in
                guard let self = self else { return }
                self.reply(token, status: response.status, contentType: "application/json; charset=utf-8",
                           body: response.body, cacheControl: "no-store", url: url, method: method)
                if path == "/api/refresh" && response.status == 200 && !self.invalidated {
                    self.onRefreshed()
                }
            }
        }
    }

    /// Form-style decoding as URLSearchParams does: "+" is a space.
    private static func decode(_ text: String) -> String {
        let spaced = text.replacingOccurrences(of: "+", with: "%20")
        return spaced.removingPercentEncoding ?? ""
    }

    // MARK: Replies

    private func replyError(_ token: Int, status: Int, code: String, url: URL, method: String, allow: String? = nil) {
        let body = Data("{\"error\":\"\(code)\"}".utf8)
        var extra: [String: String] = [:]
        if let allow = allow { extra["Allow"] = allow }
        reply(token, status: status, contentType: "application/json; charset=utf-8", body: body,
              cacheControl: "no-store", url: url, method: method, extraHeaders: extra)
    }

    private func reply(_ token: Int, status: Int, contentType: String, body: Data, cacheControl: String,
                       url: URL, method: String, extraHeaders: [String: String] = [:]) {
        // A stopped (or invalidated) task must never be messaged again.
        guard !invalidated, let task = live.removeValue(forKey: token) else { return }
        var headers = Self.securityHeaders
        headers["Content-Type"] = contentType
        headers["Content-Length"] = String(body.count)
        headers["Cache-Control"] = cacheControl
        for (name, value) in extraHeaders { headers[name] = value }
        let response: URLResponse = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                                    headerFields: headers)
            ?? URLResponse(url: url, mimeType: "application/octet-stream", expectedContentLength: body.count,
                           textEncodingName: nil)
        task.didReceive(response)
        if method != "HEAD" { task.didReceive(body) }
        task.didFinish()
    }
}
