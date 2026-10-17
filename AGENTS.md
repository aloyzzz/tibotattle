# TiboTattle agent guidance

TiboTattle is a local-first monitor for the oh-my-pi (`omp`) coding agent. It
reads omp's session logs and `usage_history` snapshots, keeps a content-free
SQLite index, and serves a loopback-only dashboard. `CLAUDE.md` imports this
file for all agents.

Before changing code, read `docs/reference/architecture.md` (module contracts)
and, for anything touching data handling, `docs/reference/privacy.md`.

## Layout

| Path | Owns |
|---|---|
| `src/paths.js`, `src/secret.js` | omp source locations, state directory, local HMAC key |
| `src/omp/` | session-record normalization, session scanner, quota reader |
| `src/store.js` | SQLite index: schema, transactions, queries |
| `src/analysis/` | periods, usage, performance and allowance summaries (pure) |
| `src/monitor.js` | refresh orchestration, file watching, change events |
| `src/server.js` | loopback HTTP server, JSON API, SSE |
| `bin/tibotattle.js` | CLI: `serve`, `scan`, `report`, `doctor` |
| `apps/web/` | dashboard (plain HTML/CSS/JS, no build step) |
| `apps/electron/` | optional desktop shell: tray and window on the loopback server |
| `apps/macos/` | native Swift menu-bar app (`docs/reference/macos-app.md`): engine in `TiboTattleCore`, UI in `TiboTattle` |
| `test/` | `node:test` suites with synthetic fixtures |
| `docs/` | architecture and privacy references, decisions, user guide |

Dependencies point inward: `apps/` and `bin/` compose `src/`; `src/analysis/`
is pure and does no I/O; nothing in `src/` imports `apps/`, `bin/` or `test/`.
The Swift engine reimplements `src/` and must match it through the shared
vectors in `test/fixtures/golden/`.

## Invariants

Changing one of these needs an explicit decision record in `docs/decisions/`,
matching tests and updated references.

- **Offline.** No outbound network requests anywhere: no telemetry, update
  checks, crash upload, remote fonts, CDNs or analytics. The Electron shell
  blocks every request outside its own loopback origin; the macOS app blocks
  every navigation outside `tibotattle://app/` and opens no socket.
- **Loopback only.** The server binds `127.0.0.1`, validates the `Host` header,
  sends a strict CSP, and requires `X-TiboTattle: 1` on mutating routes.
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
- **Zero runtime dependencies.** Node.js 22.13+ built-ins only (the macOS app:
  system frameworks only, no Swift packages). Electron is the
  single dev dependency. Do not add packages without a decision record.
- **Fixed error codes.** CLI and API errors are short codes; never print stack
  traces, paths or input back to the user.

## Working rules

- Inspect the current files and nearby tests before editing; preserve unrelated
  changes. Keep changes small and coherent; avoid speculative abstractions.
- Production code is ESM with static, reviewable imports.
- Use synthetic, content-free fixtures. Never commit real omp sessions,
  `agent.db` files, paths, account data or screenshots containing them.
- When a contract changes, update tests, `docs/reference/architecture.md`,
  `docs/reference/privacy.md` and the user guide in the same change.
- Do not push, publish, tag or create releases without explicit authorization.

## Validation

- `npm test` runs every `node:test` suite serially. It needs no install.
- Iterate with a single file: `node --test test/<name>.test.js`.
- `node bin/tibotattle.js doctor` and `scan --agent-dir <synthetic dir>` give a
  quick end-to-end check against fixture data.
- The Electron shell needs `npm install` and a GUI session. A headless smoke
  (for example under `xvfb-run`) does not prove macOS or Windows tray behavior;
  report what was actually exercised.
- The macOS app (`apps/macos`) builds and tests only on macOS with Xcode 16:
  `swift build` and `swift test` in `apps/macos`, then
  `apps/macos/build-app.sh`. CI runs these in
  `.github/workflows/macos-app.yml`; without a Swift toolchain, say the Swift
  code was not compiled. Golden vectors change only via
  `UPDATE_GOLDEN=1 node --test test/golden-vectors.test.js`.
- If a check cannot run in the current environment, say so; do not report it
  as passing.

## Review checklist

Flag changes that add network access, widen what is read from omp, store or
log content or raw identifiers, convert missing values to zero, weaken host or
CSP checks, allow double counting, downgrade the schema, or change behavior
without tests and docs.
