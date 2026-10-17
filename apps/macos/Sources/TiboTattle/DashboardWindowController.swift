// The dashboard window: a WKWebView on tibotattle://app/, created on demand
// and torn down when the window closes.
//
// - Non-persistent website data store: nothing WebKit-side is written to disk.
// - Navigation outside tibotattle://app/ is cancelled; new windows are refused.
// - The only native-to-page call is dispatching `tibotattle-change`; there are
//   no script message handlers or other JavaScript bridges.

import AppKit
import TiboTattleCore
import WebKit

@MainActor
final class DashboardWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var schemeHandler: DashboardSchemeHandler?
    private var loaded = false
    private let onClose: () -> Void

    /// In-memory only (nothing written to disk). Shared across dashboard
    /// windows so the page's remembered period survives reopening until quit.
    private static let dataStore = WKWebsiteDataStore.nonPersistent()

    init(engine: Engine, webRoot: URL?, onRefreshed: @escaping () -> Void, onClose: @escaping () -> Void) {
        self.onClose = onClose
        super.init()

        let handler = DashboardSchemeHandler(engine: engine, webRoot: webRoot, onRefreshed: onRefreshed)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = Self.dataStore
        config.setURLSchemeHandler(handler, forURLScheme: DashboardSchemeHandler.scheme)
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 820), configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.autoresizingMask = [.width, .height]

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "TiboTattle"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 520, height: 420)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("TiboTattleDashboard")

        self.schemeHandler = handler
        self.webView = webView
        self.window = window
    }

    func show() {
        guard let window = window, let webView = webView else { return }
        if !loaded {
            loaded = true
            webView.load(URLRequest(url: DashboardSchemeHandler.startURL))
        }
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
    }

    /// Tells an open dashboard that the index gained rows.
    func notifyChange() {
        guard let webView = webView, loaded else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('tibotattle-change'))", completionHandler: nil)
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        schemeHandler?.invalidate()
        if let webView = webView {
            webView.stopLoading()
            webView.navigationDelegate = nil
            webView.uiDelegate = nil
            webView.removeFromSuperview()
        }
        window?.contentView = nil
        window?.delegate = nil
        webView = nil
        schemeHandler = nil
        onClose()
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = DashboardSchemeHandler.isAppURL(navigationAction.request.url)
            && (navigationAction.targetFrame?.isMainFrame ?? false)
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(DashboardSchemeHandler.isAppURL(navigationResponse.response.url) ? .allow : .cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Reload our own page only; never navigate anywhere else.
        webView.load(URLRequest(url: DashboardSchemeHandler.startURL))
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }
}
