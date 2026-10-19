# TiboTattle agent guidance

TiboTattle is a local-first, native macOS menu-bar monitor for the oh-my-pi
(`omp`) coding agent. It reads omp's session logs and `usage_history`
snapshots, keeps a content-free SQLite index, and shows a popover and a
dashboard window served in-process. `CLAUDE.md` imports this file for all
agents.

Before changing code, read `docs/reference/architecture.md` (module contracts)
and, for anything touching data handling, `docs/reference/privacy.md`.

## Layout

| Path | Owns |
|---|---|
| `apps/macos/Sources/TiboTattleCore/` | engine: paths, keyed digests, record normalization, scanner, quota reader, SQLite store, analysis (pure), `Engine`, `APIRouter`, `SourceWatcher` |
| `apps/macos/Sources/TiboTattle/` | SwiftUI/AppKit app: menu bar, popover, dashboard window and `tibotattle://app/` scheme handler |
| `apps/macos/Tests/TiboTattleCoreTests/` | XCTest suites, synthetic fixtures, frozen golden vectors in `Fixtures/golden/` |
| `apps/macos/Resources/` | `Info.plist` (version of record), `AppIcon.icns` |
| `apps/macos/build-app.sh` | universal release build, ad-hoc signed app bundle and zip |
| `apps/web/` | dashboard (plain HTML/CSS/JS, no build step), bundled into the app |
| `docs/` | architecture and privacy references, decisions, user guide |

Dependencies point inward: the `TiboTattle` app target composes
`TiboTattleCore`; the core imports no AppKit, SwiftUI or WebKit and never
imports the app. The analysis types are pure and do no I/O.

The earlier Node.js implementation, CLI and Electron shell were removed and
live only in git history at `f140a49` (`git show f140a49:src/...`).

## Invariants

Changing one of these needs an explicit decision record in `docs/decisions/`,
matching tests and updated references.

- **Offline.** No outbound network requests anywhere: no telemetry, update
  checks, crash upload, remote fonts, CDNs or analytics. The app opens no
  socket and runs no server; the dashboard web view blocks every navigation
  outside `tibotattle://app/`.
- **Read-only toward omp.** omp files are never written. `agent.db` is opened
  read-only and only `usage_history` columns listed in the architecture
  reference are selected; `auth_credentials`, `email` and `account_id` are
  never read.
- **Content-free index.** Prompts, responses, tool calls, file paths, file
  names, cwd, emails, raw account keys and session IDs never enter the index,
  logs, API responses, errors or fixtures. Identifiers are stored only as keyed
  digests. Project labels live in memory only.
- **Vocabulary is sanitized.** Model, provider, api, tier, stop reason and limit
  names pass the vocabulary pattern or become `"unrecognized"`.
- **Missing evidence stays null.** Unknown cost is unpriced, never `$0`; absent
  timing is excluded from speed statistics, never zero; stale allowance is
  marked stale and gets no forecast.
- **Replay safe.** Re-reading a file never double counts; each file's records
  and cursor commit in one transaction.
- **Forward-only schema.** Never relabel, downgrade or wipe the index. An older
  build refuses a newer schema (`store_newer`) instead of mutating it.
- **No hosted surface.** No sharing, accounts, uploads, Worker, cloud service,
  updater feed or release-publication tooling. These were removed on purpose
  (`docs/decisions/2026-10-16-omp-edition.md`).
- **System frameworks only.** No Swift packages and no other runtime
  dependencies. Do not add one without a decision record.
- **macOS only.** Minimum macOS 13. Linux and Windows are not supported
  (`docs/decisions/2026-10-19-native-macos-only.md`).
- **Fixed error codes.** API and UI errors are short codes; never show stack
  traces, paths or input back to the user.

## Working rules

- Inspect the current files and nearby tests before editing; preserve unrelated
  changes. Keep changes small and coherent; avoid speculative abstractions.
- Use synthetic, content-free fixtures. Never commit real omp sessions,
  `agent.db` files, paths, account data or screenshots containing them.
- Golden vectors in `Fixtures/golden/` are frozen: they were generated from the
  retired Node implementation and cannot be regenerated. Change one only by a
  deliberate hand edit with a decision record.
- When a contract changes, update tests, `docs/reference/architecture.md`,
  `docs/reference/privacy.md` and the user guide in the same change.
- The version of record is `CFBundleShortVersionString` in
  `apps/macos/Resources/Info.plist`; keep `CHANGELOG.md` consistent with it.
- Do not push, publish, tag or create releases without explicit authorization.

## Validation

- Build and test on macOS with Xcode 16 only: `cd apps/macos && swift build &&
  swift test`, then `apps/macos/build-app.sh`.
- There is no Swift toolchain in the Linux cloud sandbox, so code there can only
  be compiled by the macOS CI workflow `.github/workflows/macos-app.yml`. If CI
  was not run, say the Swift code was not compiled; do not report it as passing.
- CI's launch check proves the bundle starts and creates its state directory,
  not the menu bar or popover UI. Report what was actually exercised.
- If a check cannot run in the current environment, say so.

## Review checklist

Flag changes that add network access or a socket, widen what is read from omp,
store or log content or raw identifiers, convert missing values to zero, loosen
the navigation policy or CSP, allow double counting, downgrade the schema, edit
golden fixtures without a decision record, or change behavior without tests and
docs.
