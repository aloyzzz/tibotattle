# TiboTattle architecture

TiboTattle is a native macOS menu-bar app that monitors the
[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) coding agent. It reads
omp's local session logs and omp's recorded subscription-usage snapshots, keeps
a small content-free local index, and shows the result in a popover and a
dashboard window. It has no hosted service, no sharing, no accounts, no
listening socket and no outbound network access.

It is written in Swift using only frameworks that ship with macOS (SwiftUI,
AppKit, WebKit, SQLite3, CryptoKit, CoreServices, ServiceManagement). There are
no Swift packages. Minimum macOS 13.

The earlier Node.js implementation, command-line tool and Electron shell are
retired. They remain in git history at commit `f140a49` (for example
`git show f140a49:src/server.js`). See
[the decision record](../decisions/2026-10-19-native-macos-only.md).

## Layout

All paths are under `apps/macos/` unless stated.

| Path | Owns |
|---|---|
| `Sources/TiboTattleCore/Paths.swift` | omp source locations (`OmpSources`), state directory (`StatePaths`) |
| `Sources/TiboTattleCore/Keyed.swift` | fixed error codes, local HMAC key (`KeyFile`), keyed digests (`Keyed`) |
| `Sources/TiboTattleCore/SessionRecord.swift` | pure normalization of one parsed session JSONL entry |
| `Sources/TiboTattleCore/SessionScanner.swift` | session file discovery, bounded incremental reading, cursors |
| `Sources/TiboTattleCore/QuotaReader.swift` | read-only import of `usage_history` from omp's `agent.db` |
| `Sources/TiboTattleCore/Store.swift`, `SQLite.swift` | SQLite index: schema, transactions, queries |
| `Sources/TiboTattleCore/Period.swift` | reporting periods, day bucketing, service-tier filter |
| `Sources/TiboTattleCore/Usage.swift` | token, cost and request aggregates |
| `Sources/TiboTattleCore/Performance.swift` | TPS and TTFT statistics |
| `Sources/TiboTattleCore/Allowance.swift` | current allowance per account and window, pace forecast |
| `Sources/TiboTattleCore/Engine.swift` | refresh orchestration, status, summaries |
| `Sources/TiboTattleCore/APIRouter.swift` | in-process JSON API (`/api/*`) |
| `Sources/TiboTattleCore/SourceWatcher.swift` | FSEvents watcher on the omp locations |
| `Sources/TiboTattleCore/JSON.swift`, `JSCompat.swift` | JSON value model and number/string formatting helpers that keep encoded output stable |
| `Sources/TiboTattle/TiboTattleApp.swift` | `MenuBarExtra` scene, menu-bar label, accessory activation policy |
| `Sources/TiboTattle/AppModel.swift` | owns the engine, watcher, 60 s timer, popover state, login item |
| `Sources/TiboTattle/PopoverView.swift`, `ViewModels.swift` | popover UI and its small decoding view models |
| `Sources/TiboTattle/DashboardSchemeHandler.swift` | `tibotattle://app/` scheme handler: static files plus `/api/*` |
| `Sources/TiboTattle/DashboardWindowController.swift` | dashboard `WKWebView` window and navigation policy |
| `Tests/TiboTattleCoreTests/` | XCTest suites and frozen golden fixtures |
| `Resources/` | `Info.plist`, `AppIcon.icns` |
| `build-app.sh` | universal release build to `dist/TiboTattle.app` and `.zip`, ad-hoc signed |
| `../web/` (`apps/web`) | dashboard: plain HTML/CSS/JS, no build step, copied into the app bundle |

`TiboTattleCore` imports no AppKit, SwiftUI or WebKit (only `SourceWatcher`
uses CoreServices). The analysis types are pure and do no I/O. The `TiboTattle`
app target composes the core; the core never imports the app.

## Data flow

```
 omp (read-only)                                   TiboTattle.app (one process)
 ---------------                                   ----------------------------
 <agent>/sessions/**/*.jsonl --+
                               |   SourceWatcher (FSEvents, 1 s)  60 s timer
 <agent>/agent.db              |            |                        |
   usage_history (read-only) --+            +--------+---------------+
                               |                     v
                               |              AppModel.refresh()
                               |                     |
                               v                     v
                      +-----------------------  Engine.refresh()  (single-flight)
                      | SessionScanner  QuotaReader
                      |  normalize + digest   (allowlisted columns, digests)
                      +----------+------------+
                                 v
                  ~/Library/Application Support/TiboTattle/
                    identity.key   index.sqlite  (content-free, WAL)
                                 |
                                 v
                  Usage / Performance / Allowance  (pure summaries)
                                 |
                                 v
                            APIRouter  (in-process, no socket)
                         +-------+---------------------+
                         |                             |
                  AppModel (popover)       DashboardSchemeHandler
                  menu-bar label           tibotattle://app/  -->  WKWebView
                                           static: Resources/web/   (apps/web)
                                           /api/*: APIRouter
                                           Engine change --> window event
                                                             `tibotattle-change`
```

There is **no listening socket and no HTTP server**. The popover and the
dashboard both call `APIRouter` in-process. The dashboard web view reaches it
through a `WKURLSchemeHandler`; no data crosses a network interface.

## omp sources (read-only)

`OmpSources.resolve` (Paths.swift) honors exactly these environment variables:

- **`PI_CODING_AGENT_DIR`**: the agent directory (a leading `~` is expanded).
- **`PI_CONFIG_DIR`**: when `PI_CODING_AGENT_DIR` is unset, the agent
  directory is `~/<$PI_CONFIG_DIR or .omp>/agent`.
- **`TIBOTATTLE_STATE_DIR`**: overrides the state directory (below).

Empty or whitespace-only values are ignored. Nothing else is consulted: the
Linux XDG locations that omp may use there (`XDG_DATA_HOME`, `XDG_STATE_HOME`)
are not handled, and there is no command-line override. The app reads its own
process environment, so a variable exported in a shell profile is typically not
visible to an app started from Finder or as a login item.

- **Sessions**: `<agent>/sessions/**/*.jsonl`, regular files only, symlinks not
  followed, at most 16 directory levels and 200,000 files.
  `<sessions>/<project>/<file>.jsonl` is the `main` agent; deeper files are
  `subagent`; a file named `__advisor.jsonl` or `__advisor.*.jsonl` is
  `advisor`.
- **Quota snapshots**: table `usage_history` in `<agent>/agent.db`, opened
  read-only with `busy_timeout` 2000 ms. Columns selected: `id, recorded_at,
  provider, account_key, limit_id, label, window_label, used_fraction, status,
  resets_at`. `email`, `account_id` and every other table (notably
  `auth_credentials`) are never read.

Session JSONL entries used (all other entry types are ignored):

- `{"type":"session","id","timestamp","cwd",...}` header (first line).
- `{"type":"message","id","timestamp","message":{"role":"assistant","api",
  "provider","model","usage","stopReason","timestamp","duration","ttft",
  "serviceTier","credentialId","responseId","upstreamProvider",...}}`.
- `{"type":"model_usage","id","timestamp","purpose","api","provider","model",
  "usage","stopReason"}` (auxiliary calls such as titles).

`usage` = `{input, output, cacheRead, cacheWrite, totalTokens,
cost?:{input,output,cacheRead,cacheWrite,total}}`. `output` includes reasoning.

## State directory

`StatePaths.defaultDirectory`: `$TIBOTATTLE_STATE_DIR` if set (a leading `~` is
expanded), else `~/Library/Application Support/TiboTattle`. `ensureDirectory`
creates it with mode `0700` (error `state_dir_unavailable`). It holds
`identity.key` and `index.sqlite` (+ `-wal`, `-shm`).

`KeyFile.loadOrCreate` reads `identity.key` (exactly 32 bytes, else
`key_invalid`; unreadable: `key_unreadable`) or creates it with random bytes,
mode `0600`, open flags `O_CREAT | O_EXCL` so concurrent starts cannot
overwrite each other (`key_unwritable` on failure).

## Privacy rules

- Prompts, responses, tool calls and results, file paths, file names, cwd,
  emails, raw account keys and session IDs never enter the index, logs, API
  responses or errors. Message `content` is never inspected: each line is
  parsed as JSON only so its `type` and the allowlisted fields can be read.
- Paths, session IDs, cwd and `account_key` are stored only as keyed digests
  (`Keyed.digest(key:domain:value:)`). The project display label (the final
  folder of the session's cwd, at most 128 UTF-16 units) is held **in memory
  only**, rebuilt from session headers, and passed only to the in-process API.
- Model, provider, api, upstream provider, service tier, stop reason, purpose,
  limit id, label and window label are vocabulary. They are kept if they match
  `^[A-Za-z0-9._:/@+ -]{1,128}$`, otherwise replaced by `"unrecognized"`.
- Missing evidence stays `null`. A missing cost is "unpriced", never `$0`.
  Missing duration or TTFT is excluded from speed statistics, never zero. Token
  sums are `null` when no row knows the bucket.
- Errors are fixed short codes; paths, input and SQLite messages are never
  surfaced.
- No outbound requests, and no socket (see [App shell](#app-shell)).

Keyed digest: `base64url(HMAC-SHA256(key, "tibotattle/<domain>/v1\0" + value))`
truncated to 22 characters, with the 32-byte `identity.key`.

## Core contracts

### `SessionRecord` (pure, no I/O)

```swift
SessionRecord.classifyAgentType(_ segments: [String]) -> String   // main | subagent | advisor
SessionRecord.vocab(_:)                                           // sanitizer above; nil stays nil
SessionRecord.normalizeEntry(_ entry: Any?, key: Data, sessionKey:, projectKey:, agentType:)
    -> NormalizedEntry?   // .header(sessionId:, cwd:) | .request(RequestRecord) | nil
```

A header carries the raw session id and cwd for the caller to digest; they are
never stored raw. `RequestRecord` (every key always present in JSON, `null`
when unknown):

```
requestKey      keyed('request', [responseId ?? '', entry.id, msgTimestampMs, provider, model] joined by \0)
                (no session id, so branch copies of the same turn dedupe)
ts              ms: message.timestamp if > 0, else Date.parse(entry.timestamp); record skipped if neither
provider, api, model          vocab
upstreamProvider              vocab or null
serviceTier     auto|default|flex|scale|priority|ultrafast, else null
credentialId    non-negative safe integer or null (omp's local credential row id)
agentType       main|subagent|advisor
purpose         'turn' for messages; vocab(purpose) or 'auxiliary' for model_usage
sessionKey, projectKey        digests, may be null
stopReason      stop|length|toolUse|error|aborted, else 'unrecognized';
                missing -> 'error' if errorMessage is a non-empty string, else 'aborted'
input, output, cacheRead, cacheWrite   non-negative integers (rounded); missing/invalid -> null
totalTokens     provider total if valid, else sum of the known buckets, null if none known
costUsd         usage.cost.total if finite and >= 0, else null
durationMs, ttftMs   non-negative numbers or null; ttftMs > durationMs -> ttftMs null
```

Entries without a non-empty string `id` are skipped. Records without string
`provider`, `model` or `api`, or without a `usage` object, are skipped.

### `SessionScanner`

`discoverSessionFiles` lists regular `*.jsonl` files without following
symlinks. `scanSessions(store:key:sessionRoots:labels:isCancelled:)` returns
`ScanResult { filesSeen, filesRead, requestsAdded, linesSkipped }` and fills
`labels` (projectKey to label, memory only).

Per file: `fileKey = keyed('file', absolutePath)`. The cursor comes from the
store. The file is re-read from 0 when device or inode differ or its size is
below the cursor offset, and skipped when size and mtime equal the cursor. It
is opened `O_NOFOLLOW | O_NONBLOCK` and read in 256 KiB chunks from `offset`.
Only complete `\n`-terminated lines are consumed; the cursor is the offset just
past the last complete line. Lines longer than 32 MiB are discarded while
streaming (counted, never buffered). Lines that are not JSON objects are
ignored. The header line supplies `sessionKey`, `projectKey` and the label;
the digests persist in the cursor so later appends keep their context. When
resuming at `offset > 0`, only the first line (at most 1 MiB) is read to
recover the in-memory label. Each file's new records and its new cursor are
committed in one transaction (at most 5000 records per transaction). Inserts
are `INSERT OR IGNORE`, so replay is safe.

### `QuotaReader`

`importQuotaSnapshots(store:key:agentDbPaths:)` returns `{ status, added }`
with status `ok`, `missing` or `unavailable`. It uses the first existing path,
opened `SQLITE_OPEN_READONLY`, and requires every listed column to exist
(otherwise `unavailable`). Source-side failures are reported as `unavailable`
without detail. It reads in batches of 5000 ordered by `id`, starting from a
cursor stored in the index under `quota_cursor:<digest of db path>` (a JSON
value holding the last `id` and newest `recorded_at`); if `max(id)` falls
below the cursor it restarts from 0. Snapshot record:

```
snapshotKey   keyed('snapshot', [recorded_at, provider, account_key, limit_id] joined by \0)
recordedAt    ms integer
provider, limitId   vocab           accountKey  keyed('account', provider + \0 + account_key)
label, windowLabel, status          vocab or null
usedFraction  finite number >= 0 or null (may exceed 1 = overage)
resetsAt      ms integer or null
```

Rows missing `recorded_at`, `provider`, `account_key` or `limit_id` are skipped.

### `Store`

`Store(path:)` (`:memory:` allowed) creates schema v1 and opens the file with
`busy_timeout` 5000 ms in WAL mode; the index file is created and tightened to
mode `0600` before SQLite opens it. If `meta.schema_version` is greater than 1
(or unparseable) it throws `store_newer` and changes nothing; any other
failure throws `store_unavailable`. It never downgrades, relabels or wipes.

Tables: `meta(key PK, value)`; `files(file_key PK, dev, ino, size, mtime_ms,
offset, session_key, project_key, agent_type, updated_at)`;
`requests(request_key PK, ts, provider, api, model, upstream_provider,
service_tier, credential_id, agent_type, purpose, session_key, project_key,
stop_reason, input, output, cache_read, cache_write, total_tokens, cost_usd,
duration_ms, ttft_ms)` with an index on `ts`; `snapshots(snapshot_key PK,
recorded_at, provider, account_key, limit_id, label, window_label,
used_fraction, status, resets_at)` with an index on `(provider, account_key,
limit_id, recorded_at)`.

API: `getMeta/setMeta`, `getCursor`, `commitFile` (records plus cursor in one
transaction), `commitSnapshots` (snapshots plus import cursor in one
transaction), `queryRequests(fromMs:toMs:)` (`ts` in `[from, to)`),
`querySnapshots(fromMs:toMs:)`, `counts()`, `close()`. All access is
serialized by a lock.

### `Period`

`Period` is `24h`, `7d`, `30d` or `all`. `resolve(nowMs:)` returns
`{ name, fromMs, toMs }` with `toMs = floor(now) + 1` and `fromMs = max(0,
now - span)`; `all` starts at 0. `Period.dayKey(ts, tzOffsetMinutes)` gives
`YYYY-MM-DD` in a zone `tzOffsetMinutes` east of UTC (the dashboard sends
`-getTimezoneOffset()`). `TierFilter` is `all`, `unreported` (null tier) or one
of `auto|default|flex|scale|priority|ultrafast`.

### Usage

`UsageAnalysis.summarize(rows, tzOffsetMinutes:, labels:)`:

```
totals, byProvider[], byModel[], byCredential[]   (credentialId null = "unattributed")
byProject[] (projectKey, label from the in-memory map or null), byAgentType[],
byServiceTier[], daily[] (ascending, only days with rows)
Totals = { requests, sessions, input, output, cacheRead, cacheWrite, totalTokens,
           costUsd, pricedRequests, unpricedRequests, errorRequests,
           unknownTokenRequests, cacheHitRate }
```

Token buckets sum only rows where the bucket is known and are `null` if no row
knows it. `costUsd` sums priced rows only and is `null` when none is priced;
rows without cost count as `unpricedRequests`. `cacheHitRate = cacheRead /
(input + cacheRead)` over rows that report both, `null` when the denominator is
0. `sessions` counts distinct non-null session digests. Lists are sorted by
total tokens descending.

### Performance

`PerformanceAnalysis.summarize(rows, tzOffsetMinutes:, serviceTier:)`.

Eligible rows: `purpose == "turn"`, `stopReason` in `stop|toolUse|length`,
`output > 0` and `durationMs > 0`. Per eligible row:

- **Decode TPS** = `output / ((durationMs - ttftMs) / 1000)`, only when
  `ttftMs` is known and `durationMs - ttftMs >= 100`.
- **Request TPS** = `output / (durationMs / 1000)`.
- **TTFT** = `ttftMs` as recorded (already `null` if it exceeded the duration).

Rows lacking an input are left out of that statistic, never counted as zero.
Output:

```
models[] = { provider, model, requests, timedRequests, decodeTps: Stats,
             requestTps: Stats, ttftMs: Stats,
             daily: [{ day, decodeTpsMedian, ttftMedian, n }] }   // by requests desc
tiers[]  = { serviceTier, requests }
Stats    = { n, median, p25, p75, mean }   // all null when n = 0; linear-interpolation percentiles
```

### Allowance

`AllowanceAnalysis.summarize(snapshots, nowMs:, staleAfterMs: 30 min)` groups
by `(provider, accountKey, limitId)`. Each series:

```
provider, accountKey, accountLabel ("<provider> account <first 6 chars of the digest>"),
limitId, label, windowLabel, usedFraction, remainingFraction (max(0, 1 - used); null if used null),
status, resetsAt, recordedAt, ageMs, stale (ageMs > 30 min),
pace: null | { ratePerHour, projectedExhaustAt, exhaustsBeforeReset, basisStartAt, basisPoints },
history: [{ t, used }]   // last 30 days, at most 400 points (the maximum per bucket is kept)
```

Pace uses the readings since the most recent reset, where a reset is a drop in
`usedFraction` of more than 0.05 or a change of `resetsAt` of more than one
minute. It needs at least two readings spanning at least 20 minutes and a
positive increase; otherwise `pace` is `null`. A stale series always has
`pace: null` (no forecast). Series are sorted by provider, account label,
label.

### `Engine`

`Engine(sources:stateDirectory:)` creates the state directory, loads or creates
the key and opens the index. It throws `state_dir_unavailable`, `store_newer`
or `store_unavailable`.

- `refresh()` scans sessions and imports quota snapshots. It is single-flight:
  runs execute one at a time on an internal serial queue and callers that
  arrive during a run share one follow-up run. Errors do not throw; they are
  recorded as a fixed code in `status().lastError` (`scan_failed`,
  `quota_failed`, `store_newer`, `aborted`).
- `generation` is a data version that increases only when a refresh added
  requests or snapshots. `onChange` fires after such a refresh.
- `status()` returns `{ generation, lastRefreshAt, lastError, refreshing,
  sources: { sessionRoots: [{ status: readable|missing }], agentDb:
  ok|missing|unavailable|null }, counts: { requests, snapshots, files } }`.
- `usage`, `performance` and `allowance` query the index directly, so they are
  not blocked behind a long scan. `labels` is the in-memory project map.

### `SourceWatcher`

FSEvents stream (file-level events, 1 s latency) on the existing session roots
and the `agent.db` directory. It only signals "something changed" and carries
no paths. Non-existent paths are skipped; callers keep a fallback timer.

## In-process API

`APIRouter.handle(method:path:query:headers:engine:now:)` (and a variant taking
a full URL) returns an HTTP-like `(status, body)` where the body is UTF-8 JSON.
The dashboard reaches it as `tibotattle://app/api/*`; the popover calls it
directly. Query parameters (GET routes): `period` in `24h|7d|30d|all` (default
`7d`), `tz` integer minutes east of UTC in -840...840 (default `0`), `tier` for
`/api/performance` (default `all`). A repeated parameter is rejected. Unknown
parameters are ignored.

| Route | Response |
|---|---|
| `GET /api/status` | `Engine.status()` |
| `GET /api/usage?period&tz` | `{ period, ...UsageSummary }` |
| `GET /api/performance?period&tz&tier` | `{ period, ...PerformanceSummary }` |
| `GET /api/allowance` | `{ nowMs, series }` (snapshots from the last 30 days) |
| `GET /api/overview?period&tz` | `{ period, totals, byProvider, allowance, topModels }` (top 5 models by requests, all tiers) |
| `POST /api/refresh` | requires header `X-TiboTattle: 1` (name matched case-insensitively); runs `Engine.refresh()`; `{ generation }` |

`period` is `{ name, fromMs, toMs }`. Query validation applies to every GET
route, including `/api/status` and `/api/allowance`.

Errors are `{ "error": "<code>" }` and never echo input:

| Status | Code | When |
|---|---|---|
| 400 | `bad_period` | unknown or repeated `period` |
| 400 | `bad_tz` | repeated, non-integer or out-of-range `tz` |
| 400 | `bad_tier` | unknown or repeated `tier` |
| 400 | `bad_request` | the URL cannot be parsed |
| 403 | `missing_header` | `POST /api/refresh` without `X-TiboTattle: 1` |
| 404 | `not_found` | any other path, including `/api/events` |
| 405 | `method_not_allowed` | wrong method for a known route |
| 500 | `internal` | unexpected failure |

`DashboardSchemeHandler` adds the static side. It serves a fixed allowlist from
the bundle's `Resources/web` directory (`/` and `/index.html`, `/app.js`,
`/styles.css`, `/favicon.svg`; request paths are never joined onto the
filesystem) for `GET` and `HEAD` (others get 405), and it routes `/api/*` to
`APIRouter` off the main thread. It rejects a repeated `period`, `tz` or `tier`
before routing, and every response carries `Content-Security-Policy`
(`default-src 'self'; img-src 'self' data:; style-src 'self'; script-src
'self'; connect-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and same-origin
`Cross-Origin-*` policies.

## App shell

- **`TiboTattleApp`**: a `MenuBarExtra` (window style) with an accessory
  activation policy (`LSUIElement`, no Dock icon). The label is the lowest
  remaining allowance among fresh series (`62%`), `62%?` when every series is
  stale, or only an icon when there is no allowance data.
- **`AppModel`** (main actor): starts the engine on a serial work queue, owns
  the `SourceWatcher`, a 60 s fallback timer and the published popover state.
  All engine and router calls run on the work queue. Refreshes are coalesced; a
  newer load is never overwritten by an older one. It registers or unregisters
  the login item with `SMAppService.mainApp`. If the engine cannot start it
  shows a fixed message (`store_newer` or the error code) instead of summaries.
- **`PopoverView`**: allowance meters (remaining, reset countdown, stale badge,
  pace line, last reading), totals for the period, the top five models with
  median decode TPS and TTFT, a period picker, and Open Dashboard, Refresh,
  Start at login and Quit. The period choice is stored in `UserDefaults`
  (`popover.period`).
- **`DashboardWindowController`**: a `WKWebView` on `tibotattle://app/`,
  created on demand and torn down when the window closes. It uses a
  non-persistent `WKWebsiteDataStore` (nothing WebKit-side is written to disk),
  cancels every navigation outside `tibotattle://app/` (scheme, host `app`, no
  port or credentials), refuses new windows, and has no script message
  handlers. The only native-to-page call is dispatching the window event
  `tibotattle-change` after a refresh that added rows. The window frame is
  autosaved under the name `TiboTattleDashboard`.

### Dashboard (`apps/web`)

Pages by hash route: `#/overview`, `#/usage`, `#/performance`, `#/allowance`,
`#/projects`. The header has the reporting-period control (remembered with
`localStorage`, wrapped in try/catch) and a refresh button. The page refetches
the current view on the `tibotattle-change` window event and polls
`/api/status`, refetching when `generation` changes. (The page also contains an
`EventSource` branch; the app answers `/api/events` with `not_found`, so the
page falls back to polling.) API URLs are resolved against
`window.location.href`. Charts are inline SVG; there are no external assets and
the page works offline in light and dark themes.

## Build, signing and CI

`build-app.sh` builds a universal (arm64 + x86_64) release binary, assembles
`dist/TiboTattle.app` (Info.plist, `AppIcon.icns`, and the `apps/web` files
under `Resources/web`), strips symbols, signs ad-hoc with the hardened runtime
and no timestamp server, and zips it to `dist/TiboTattle-macos.zip`. It is not
notarized. `.github/workflows/macos-app.yml` builds, tests and smoke-launches
the app on macOS and keeps the zip as a workflow artifact. The version of
record is `CFBundleShortVersionString` in `Resources/Info.plist`.

## Golden fixtures

`Tests/TiboTattleCoreTests/Fixtures/golden/` holds frozen JSON vectors that pin
the behavior described above (digests, record normalization, usage,
performance, allowance, index schema). They were originally generated from the
retired Node implementation at `f140a49` and can no longer be regenerated.
Changing one is a deliberate hand edit that needs a decision record. See
[macos-app.md](macos-app.md).
