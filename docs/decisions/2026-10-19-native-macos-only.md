# Decision: TiboTattle is only the native macOS app

- **Date**: 2026-10-19
- **Status**: accepted
- **Applies from**: 0.3.0
- **Supersedes in part**: [omp edition](2026-10-16-omp-edition.md) (Node.js
  runtime, CLI and Electron shell) and
  [native macOS app](2026-10-17-native-macos-app.md) (dual implementation,
  shared index, Electron for other platforms)

## Context

After the omp edition, TiboTattle had two implementations of the same engine: a
Node.js one (CLI, loopback HTTP server, Electron tray shell) and a native Swift
macOS app that reimplemented it and was pinned to it by shared golden vectors.
Electron was heavy (a full Chromium and Node runtime for a menu-bar number and
an occasional dashboard). The native app already covers everything the Node
side did for its users: indexing, allowance, usage, speed, dashboard, start at
login. Keeping both meant every contract change had to be made twice.

## Decision

Remove the Node implementation and the Electron shell. The native macOS app in
`apps/macos` is the only product. The last commit that contains the retired
code is `f140a49` (for example `git show f140a49:src/server.js`).

Removed:

- The Electron desktop shell (`apps/electron`).
- The Node.js engine (`src/`), the CLI (`bin/`: `serve`, `scan`, `report`,
  `doctor`), the loopback HTTP server and server-sent events, and
  `package.json`.
- The `node:test` suites and the Node CI workflow.

Kept or moved:

- `apps/web`, the dashboard, remains plain HTML, CSS and JavaScript with no
  build step, served from the app bundle on `tibotattle://app/`.
- The golden vectors moved into
  `apps/macos/Tests/TiboTattleCoreTests/Fixtures/golden`.
- The app icon moved to `apps/macos/Resources/AppIcon.icns`.
- The Swift engine, index format (schema version 1), state directory and key
  file are unchanged, so an existing index keeps working.

All invariants in `AGENTS.md` still apply. "Zero runtime dependencies" is now
"system frameworks only, no Swift packages", and the loopback-server rules are
replaced by "no socket at all" plus the `tibotattle://app/` navigation policy.

## Consequences

- No Linux or Windows support, and no command-line tool. People who need those
  can use the code at `f140a49`, which is no longer maintained.
- There are no Node tests. The golden vectors can no longer be regenerated:
  they are frozen fixtures that pin behavior. Changing one means a deliberate
  hand edit with a decision record, in the same change as the behavior.
- The dashboard's static checks (no inline scripts, no external URLs, strict
  CSP meta tag, native-scheme compatibility, API contract use) now run as
  XCTest.
- Swift code builds and tests only on macOS (Xcode 16). Agents without a Swift
  toolchain, such as the Linux cloud sandbox, rely on the macOS CI workflow and
  must say when the Swift code was not compiled.
- The version of record is `CFBundleShortVersionString` in
  `apps/macos/Resources/Info.plist`. Release 0.3.0 is the first to have no
  `package.json`.
- Documentation, issue templates and the pull request template describe only
  the macOS app.

## Alternatives considered

- **Keep Electron for Linux and Windows.** Rejected: it keeps a second
  implementation, a heavy runtime and a loopback server alive for platforms the
  maintainer does not use, and every contract change would still be made twice.
- **Keep the Node CLI as a reference implementation.** Rejected: a reference
  that is not shipped or run in CI drifts, and git history at `f140a49`
  preserves it for anyone who needs to read it. The golden vectors keep the
  Swift engine pinned to its original behavior.
