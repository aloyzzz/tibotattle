# macOS app reference

`apps/macos` is TiboTattle: a native Swift menu-bar app. It is one universal
binary using only frameworks that ship with macOS (SwiftUI/AppKit, SQLite3,
CryptoKit, WebKit, CoreServices FSEvents, ServiceManagement). It has no Swift
packages and no bundled browser or runtime. The module contracts, data flow,
index schema, analysis definitions and API routes are in
[architecture.md](architecture.md); this page covers the app shell, the Swift
package and the frozen test vectors. Where this file is silent,
`architecture.md` wins.

## Shape

- **Menu bar item** (`MenuBarExtra`, `.window` style). Label: the lowest
  remaining allowance among fresh series, formatted `62%` (with the window
  label in the tooltip), `62%?` when every series is stale, or just the icon
  when there is no allowance data.
- **Popover**: allowance meters per account and window (remaining, reset
  countdown, stale badge, pace line), totals for the selected period (requests,
  tokens, cost with unpriced count, cache hit rate), the top five models with
  median decode TPS and TTFT, a period picker (24h/7d/30d/All), and buttons:
  Open Dashboard, Refresh, Start at login (toggle), Quit.
- **Dashboard window** (opened on demand, released when closed): a `WKWebView`
  showing the `apps/web` dashboard, served from the app bundle through a
  `WKURLSchemeHandler` on `tibotattle://app/`. `/api/*` requests are answered
  in-process by `APIRouter`. No HTTP server and no listening socket exist in
  the app. `/api/events` is not served (404 `not_found`), so the dashboard
  falls back to polling `/api/status` and also listens for the
  `tibotattle-change` window event.
- **Live updates**: an FSEvents stream on the session roots and the agent.db
  directory (latency 1 s), plus a 60 s fallback timer. A refresh that adds rows
  updates the menu bar and popover and dispatches `tibotattle-change` in an
  open dashboard.
- `LSUIElement` is true (no Dock icon). Minimum macOS 13. Universal
  (arm64 + x86_64). Ad-hoc signed by the build script; not notarized.
- Cancels all navigation outside `tibotattle://app/`; opens no network socket
  and makes no network requests.

## State

The state directory is `~/Library/Application Support/TiboTattle`, or
`$TIBOTATTLE_STATE_DIR` when set. It holds `identity.key` and `index.sqlite`
(schema version 1). The app also keeps two macOS preferences under
`io.github.aloyzzz.tibotattle` (the popover period and the dashboard window
frame) and, when enabled, a login item. Details and deletion steps are in
[privacy.md](privacy.md).

## Swift package

```
apps/macos/
  Package.swift                 // swift-tools-version 5.9, platforms: .macOS(.v13)
  Sources/TiboTattleCore/       // library: no AppKit/SwiftUI/WebKit imports
  Sources/TiboTattle/           // executable: SwiftUI app, popover, dashboard window
  Tests/TiboTattleCoreTests/    // XCTest: core, router, golden vectors, dashboard static checks
  Resources/                    // Info.plist, AppIcon.icns
  build-app.sh                  // universal release build -> dist/TiboTattle.app (+ .zip), ad-hoc signed
```

Build and test (macOS only, Xcode 16 / Swift 6 toolchain):

```sh
cd apps/macos && swift build && swift test
apps/macos/build-app.sh      # -> apps/macos/dist/TiboTattle.app and TiboTattle-macos.zip
```

### `TiboTattleCore` public API

```swift
public struct OmpSources: Sendable, Equatable {
    public var agentDirs: [URL]; public var sessionRoots: [URL]; public var agentDbPaths: [URL]
    public static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment,
                               home: URL = FileManager.default.homeDirectoryForCurrentUser,
                               agentDir: URL? = nil) -> OmpSources
}
public enum StatePaths { public static func defaultDirectory(environment: [String: String], home: URL = ...) -> URL }

public enum Period: String, CaseIterable, Sendable { case h24 = "24h", d7 = "7d", d30 = "30d", all }
public enum TierFilter: Sendable, Equatable { case all, unreported, tier(String) }

public final class Engine: @unchecked Sendable {   // all access serialized internally
    public init(sources: OmpSources, stateDirectory: URL) throws
    @discardableResult public func refresh() throws -> RefreshResult   // single-flight
    public func status() -> EngineStatus
    public func usage(period: Period, tzOffsetMinutes: Int, now: Date) throws -> UsageSummary
    public func performance(period: Period, tzOffsetMinutes: Int, tier: TierFilter, now: Date) throws -> PerformanceSummary
    public func allowance(now: Date) throws -> [AllowanceSeries]
    public var labels: [String: String] { get }      // projectKey -> label, memory only
    public var onChange: (@Sendable (Int) -> Void)? { get set }
}

public enum APIRouter {
    /// Returns an HTTP-like status and a UTF-8 JSON body for /api/* routes.
    public static func handle(method: String, path: String, query: [String: String],
                              headers: [String: String], engine: Engine, now: Date) -> (status: Int, body: Data)
}

public final class SourceWatcher {                   // FSEvents; macOS only
    public init(paths: [URL], latency: TimeInterval = 1.0, onChange: @escaping @Sendable () -> Void)
    public func start(); public func stop()
}
```

`UsageSummary`, `PerformanceSummary`, `AllowanceSeries` and `EngineStatus` are
`Codable` structs whose encoded JSON uses the key names, `null` for missing
values and array ordering documented in `architecture.md`. They encode through
an explicit JSON value model so `null` is written rather than omitted.

## Frozen golden vectors

`apps/macos/Tests/TiboTattleCoreTests/Fixtures/golden/` holds JSON vectors that
pin the engine's behavior. They were originally generated from the retired
Node implementation at commit `f140a49` and can no longer be regenerated: that
implementation is gone. They are now ordinary frozen fixtures. Changing one
means deliberately editing it by hand, in the same change as the behavior it
describes and with a decision record in `docs/decisions/`.

| File | Contents |
|---|---|
| `keyed.json` | `{ keyHex, cases: [{ domain, value, expected }] }` keyed digests |
| `records.json` | `{ keyHex, context, cases: [{ name, entry, expected }] }` where `expected` is `null`, a header object, or a `RequestRecord` |
| `usage.json` | `{ options, rows, expected }` for the usage summary |
| `performance.json` | `{ cases: [{ options, rows, expected }] }` for the performance summary |
| `allowance.json` | `{ options, snapshots, expected }` for the allowance summary |
| `schema.json` | tables, columns, indexes and initial metadata of schema v1 |

Numbers compare with a relative tolerance of 1e-9. `GoldenTests` asserts every
vector.

## Tests

`swift test` runs XCTest suites for the scanner (incremental reads, replay,
truncation, symlinks, oversize lines, content-free index), the quota reader
(allowlisted columns, incremental import), the store (modes, WAL, dedupe,
refusal of a newer schema without rewriting), `APIRouter` (error codes,
shapes, owner-only state files, collapsed concurrent refreshes), the golden
vectors, and static checks of the `apps/web` dashboard files (no inline
scripts, no external URLs, strict CSP meta tag, works under the native scheme).
The SwiftUI app target and the WebKit window have no automated UI tests; they
are exercised by building the app and, in CI, launching it.
