# Decision: a native Swift menu-bar app for macOS

- **Date**: 2026-10-17
- **Status**: accepted
- **Applies from**: 0.2.x (unreleased)

## Context

On macOS the only desktop option was the Electron shell: a full Chromium and
Node.js runtime (hundreds of megabytes on disk, a resident renderer and GPU
process) to show one number in the menu bar and, occasionally, the dashboard.
Most of the time a TiboTattle user only glances at the remaining allowance.
macOS already ships everything TiboTattle needs: SwiftUI and AppKit for the
menu bar, SQLite3, CryptoKit for HMAC-SHA256, FSEvents for file watching and
WebKit for the dashboard.

The [omp edition decision](2026-10-16-omp-edition.md) removed the Codex-era
native macOS app together with its signing, notarization, updater and release
tooling. That removal was about the hosted and release surface, not about
native code as such.

## Decision

Add `apps/macos`, a native Swift menu-bar app for macOS 13 or newer, specified
in [the macOS app reference](../reference/macos-app.md):

- A Swift engine (`TiboTattleCore`) reimplements the Node index, scanner,
  quota reader and analysis with system frameworks only. It shares the state
  directory, `identity.key`, `index.sqlite` and schema version 1 with the Node
  CLI, so either program can read and extend the other's index.
- Equivalence is enforced by shared golden vectors in `test/fixtures/golden/`,
  generated from the Node implementation and asserted by both test suites.
- The existing `apps/web` dashboard is reused unchanged in shape: a
  `WKWebView` loads it from the app bundle through a `tibotattle://app/`
  scheme handler that answers `/api/*` in-process with the same JSON as
  `src/server.js`. No HTTP server or socket exists in the native app.
- The build script produces a universal, ad-hoc signed, non-notarized bundle.
  CI (`.github/workflows/macos-app.yml`) builds, tests and smoke-launches it
  and keeps the zip as a 14-day workflow artifact.

The Electron shell stays as the desktop option for Linux and Windows (and
remains usable on macOS).

## Consequences

- Every invariant in `AGENTS.md` applies to the Swift code: offline, read-only
  toward omp, content-free index, sanitized vocabulary, null for missing
  evidence, replay safety, forward-only schema and fixed error codes. The
  loopback-server rules are replaced by "no socket at all" and a navigation
  policy that allows only `tibotattle://app/`.
- Two implementations of the engine must move together. A contract change now
  also means regenerating the golden vectors and updating the Swift engine in
  the same change.
- Swift code builds and tests only on macOS. Contributors without a Mac rely
  on CI; agents without a Swift toolchain must say the Swift code was not
  compiled.
- The CI artifact is a build output for testing, not a release: there is no
  publication step, updater feed, notarization or download page. First launch
  needs right-click → Open or removing the quarantine attribute.
- The dashboard gains a polling fallback (`/api/status` every 5 s) and a
  `tibotattle-change` window event, because the native app has no server-sent
  events. Under the Node server it keeps using `/api/events`.

## Alternatives considered

- **Keep Electron only.** Rejected for macOS: too heavy for a menu-bar glance.
- **Bundle Node.js and run the existing server in a native shell.** Rejected:
  still ships a runtime, still opens a loopback port, and adds a process to
  supervise.
- **A native app talking to a separately started Node server.** Rejected: two
  things to install and keep running, and the menu bar would be empty whenever
  the server is not.
- **Rewrite the dashboard natively.** Rejected for now: the web dashboard
  already exists, is tested and works offline; WebKit renders it with no
  added weight.
