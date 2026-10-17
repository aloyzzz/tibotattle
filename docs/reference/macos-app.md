# Native macOS app

`apps/macos` is a native Swift menu-bar app. It is the lightest way to run
TiboTattle on a Mac: one universal binary using only frameworks that ship with
macOS (SwiftUI/AppKit, SQLite3, CryptoKit, WebKit, CoreServices FSEvents). It
needs no Node.js, no Electron and no bundled browser. It follows every invariant
in `AGENTS.md` and the module contracts in `architecture.md`; where this file is
silent, `architecture.md` wins.

## Shape

- **Menu bar item** (`MenuBarExtra`, `.window` style). Label: the lowest
  remaining allowance among fresh series, formatted `62%` (with the window
  label in the tooltip), `62%?` when every series is stale, or just the icon
  when there is no allowance data.
- **Popover**: allowance meters per account and window (remaining, reset
  countdown, stale badge, pace line), totals for the selected period (requests,
  tokens, cost with unpriced count, cache hit rate), the top five models with
  median decode TPS and TTFT, a period picker (24h/7d/30d/All), and buttons:
  Open dashboard, Refresh, Start at login (toggle), Quit.
- **Dashboard window** (opened on demand, released when closed): a `WKWebView`
  showing the existing `apps/web` dashboard, served from the app bundle through
  a `WKURLSchemeHandler` on `tibotattle://app/`. `/api/*` requests are answered
  in-process by the Swift engine with exactly the JSON shapes `src/server.js`
  returns. No HTTP server and no listening socket exist in the native app.
- **Live updates**: an FSEvents stream on the session roots and the agent.db
  directory (latency 1 s), plus a 60 s fallback timer. A refresh that adds rows
  updates the menu bar and popover and calls
  `window.dispatchEvent(new Event('tibotattle-change'))` in an open dashboard.
- `LSUIElement` is true (no Dock icon). Minimum macOS 13. Universal
  (arm64 + x86_64). Ad-hoc signed by the build script; not notarized.
- Blocks all navigation outside `tibotattle://app/`; makes no network requests.

## Compatibility with the Node implementation

The Swift engine and the Node CLI share the state directory
(`~/Library/Application Support/TiboTattle`, or `$TIBOTATTLE_STATE_DIR`), the
key file `identity.key`, the index file `index.sqlite` and schema version 1.
Digests, record normalization and analysis results must be byte-for-byte or
value-for-value identical, so either program can read and extend the other's
index. Both open the index in WAL mode with `busy_timeout` 5000 ms.

`test/fixtures/golden/` holds shared vectors checked by both test suites:

| File | Contents |
|---|---|
| `keyed.json` | `{ keyHex, cases: [{ domain, value, expected }] }` |
| `records.json` | `{ keyHex, context, cases: [{ name, entry, expected }] }` where `expected` is `null`, a header object, or a `RequestRecord` |
| `usage.json` | `{ options, rows, expected }` for `summarizeUsage` |
| `performance.json` | `{ cases: [{ options, rows, expected }] }` for `summarizePerformance` |
| `allowance.json` | `{ options, snapshots, expected }` for `summarizeAllowance` |

Numbers compare with a relative tolerance of 1e-9. Vectors are generated from
the Node implementation by `test/golden-vectors.test.js` when run with
`UPDATE_GOLDEN=1` and asserted otherwise.

## Swift package

```
apps/macos/
  Package.swift                 // swift-tools-version 5.9, platforms: .macOS(.v13)
  Sources/TiboTattleCore/       // library: no AppKit/SwiftUI/WebKit imports
  Sources/TiboTattle/           // executable: SwiftUI app, popover, dashboard window
  Tests/TiboTattleCoreTests/    // XCTest, including the golden vectors
  Resources/Info.plist
  build-app.sh                  // universal release build -> dist/TiboTattle.app (+ .zip), ad-hoc signed
```

### `TiboTattleCore` public API

```swift
public struct OmpSources: Sendable {
    public var sessionRoots: [URL]; public var agentDbPaths: [URL]
    public static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment,
                               home: URL = FileManager.default.homeDirectoryForCurrentUser,
                               agentDir: URL? = nil) -> OmpSources
}
public enum StatePaths { public static func defaultDirectory(environment: [String: String]) -> URL }

public enum Period: String, CaseIterable, Sendable { case h24 = "24h", d7 = "7d", d30 = "30d", all }
public enum TierFilter: Sendable { case all, unreported, tier(String) }

public final class Engine: @unchecked Sendable {   // all access serialized on an internal queue
    public init(sources: OmpSources, stateDirectory: URL) throws
    @discardableResult public func refresh() throws -> RefreshResult   // single-flight
    public func status() -> EngineStatus
    public func usage(period: Period, tzOffsetMinutes: Int, now: Date) throws -> UsageSummary
    public func performance(period: Period, tzOffsetMinutes: Int, tier: TierFilter, now: Date) throws -> PerformanceSummary
    public func allowance(now: Date) throws -> [AllowanceSeries]
    public var labels: [String: String] { get }      // projectKey -> label, memory only
}

public struct RefreshResult: Sendable { public let generation: Int; public let requestsAdded: Int; public let snapshotsAdded: Int }

public enum APIRouter {
    /// Answers the same routes as src/server.js (minus static files and /api/events).
    /// Returns HTTP-like status and a UTF-8 JSON body.
    public static func handle(method: String, path: String, query: [String: String],
                              headers: [String: String], engine: Engine, now: Date) -> (status: Int, body: Data)
}

public final class SourceWatcher {                   // FSEvents; macOS only
    public init(paths: [URL], latency: TimeInterval = 1.0, onChange: @escaping @Sendable () -> Void)
    public func start(); public func stop()
}
```

`UsageSummary`, `PerformanceSummary`, `AllowanceSeries` and `EngineStatus` are
`Codable` structs whose encoded JSON equals the Node shapes (same key names,
`null` for missing values, same ordering of arrays). Encode with
`JSONEncoder` and explicit `encode(_:forKey:)` / `encodeNil` where needed so
`null` is written, not omitted.
