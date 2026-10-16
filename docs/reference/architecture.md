# TiboTattle (omp edition) architecture

TiboTattle monitors the [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`)
coding agent. It reads omp's local session logs and omp's recorded
subscription-usage snapshots, keeps a small content-free local index, and serves
a loopback-only dashboard. It has no hosted service, no community sharing, no
accounts and no outbound network access.

Runtime: Node.js 22.13+ built-ins only (`node:sqlite`, `node:http`, `node:fs`,
`node:crypto`). The optional desktop shell uses Electron 38. There are no
runtime npm dependencies.

## Layout

| Path | Owns |
|---|---|
| `src/paths.js` | omp source locations and TiboTattle state directory |
| `src/secret.js` | local HMAC key and keyed digests |
| `src/omp/session-record.js` | pure normalization of one parsed session JSONL entry |
| `src/omp/session-scanner.js` | session file discovery, bounded incremental reading, cursors |
| `src/omp/quota-reader.js` | read-only import of `usage_history` from omp's `agent.db` |
| `src/store.js` | local SQLite index (schema, transactions, queries) |
| `src/analysis/period.js` | reporting periods and day bucketing |
| `src/analysis/usage.js` | token, cost and request aggregates |
| `src/analysis/performance.js` | TPS and TTFT statistics |
| `src/analysis/allowance.js` | current allowance per account and window, pace forecast |
| `src/monitor.js` | refresh orchestration, file watching, change events |
| `src/server.js` | loopback HTTP server: static dashboard, JSON API, SSE |
| `bin/tibotattle.js` | CLI (`serve`, `scan`, `report`, `doctor`) |
| `apps/web/` | dashboard (`index.html`, `app.js`, `styles.css`), no build step |
| `apps/electron/` | desktop shell: tray plus a window on the loopback server |
| `test/` | `node:test` suites with synthetic, content-free fixtures |

## omp sources (read-only)

- **Agent directory**: `$PI_CODING_AGENT_DIR` if set, otherwise
  `~/<$PI_CONFIG_DIR or .omp>/agent`. On Linux, when `$XDG_DATA_HOME/omp`
  exists and no agent-dir override is set, `$XDG_DATA_HOME/omp` is also checked
  (omp flattens `agent/` under XDG). A CLI `--agent-dir` flag overrides all.
- **Sessions**: `<agent>/sessions/**/*.jsonl` (XDG: `$XDG_DATA_HOME/omp/sessions`).
  `<sessions>/<project>/<file>.jsonl` is the `main` agent; deeper files are
  `subagent`; any file named `__advisor.jsonl` or `__advisor.*.jsonl` is `advisor`.
- **Quota snapshots**: table `usage_history` in `<agent>/agent.db`
  (XDG: `$XDG_DATA_HOME/omp/agent.db`), opened read-only. Columns used:
  `id, recorded_at, provider, account_key, limit_id, label, window_label,
  used_fraction, status, resets_at`. `email`, `account_id` and every other
  table (notably `auth_credentials`) are never read.

Session JSONL entries used (all other entry types are ignored):

- `{"type":"session","id","timestamp","cwd",...}` header (first line).
- `{"type":"message","id","timestamp","message":{"role":"assistant",
  "api","provider","model","usage","stopReason","timestamp","duration",
  "ttft","serviceTier","credentialId","responseId","upstreamProvider",...}}`.
- `{"type":"model_usage","id","timestamp","purpose","api","provider",
  "model","usage","stopReason"}` (auxiliary calls such as titles).

`usage` = `{input, output, cacheRead, cacheWrite, totalTokens,
cost?:{input,output,cacheRead,cacheWrite,total}}`. `output` includes reasoning.

## Privacy rules

- Prompts, responses, tool calls/results, file paths, filenames, cwd, emails,
  raw account keys and session IDs never enter the index, logs, API responses
  or errors. Message `content` is never inspected beyond `JSON.parse`.
- Paths, session IDs, cwd and `account_key` are stored only as keyed digests
  (`keyed(key, domain, value)`). The project display label (the cwd basename)
  is held **in memory only**, rebuilt from session headers at startup, and
  served only over loopback.
- Model, provider, api, service tier, stop reason, limit id and window labels
  are vocabulary. They are kept if they match `^[A-Za-z0-9._:/@+ -]{1,128}$`,
  otherwise replaced by `"unrecognized"`.
- Missing evidence stays `null`. A missing cost is "unpriced", never `$0`.
  Missing duration/TTFT is excluded from speed statistics, never zero.
- The HTTP server binds `127.0.0.1` only, rejects any `Host` header other than
  `127.0.0.1:<port>` or `localhost:<port>`, and sends
  `Content-Security-Policy: default-src 'self'`. Mutating routes require
  header `X-TiboTattle: 1`. No outbound requests anywhere.

## Module contracts

All modules are ESM. Function names below are the public API; tests import them.

### `src/paths.js`

```js
resolveOmpSources({ env = process.env, home = os.homedir(), platform = process.platform, agentDir } = {})
// -> { agentDirs: string[], sessionRoots: string[], agentDbPaths: string[] }
//    absolute, de-duplicated, existence NOT required.
resolveStateDir({ env, home, platform } = {})
// -> $TIBOTATTLE_STATE_DIR, else macOS ~/Library/Application Support/TiboTattle,
//    Windows %APPDATA%\TiboTattle, Linux ${XDG_STATE_HOME:-~/.local/state}/tibotattle
ensureStateDir(dir)   // mkdir -p with mode 0o700; returns dir
```

### `src/secret.js`

```js
loadOrCreateKey(stateDir)      // 32 random bytes in <stateDir>/identity.key, mode 0o600,
                               // created with flag 'wx' (race-safe); returns Buffer
keyed(key, domain, value)      // base64url(HMAC-SHA256(key, `tibotattle/${domain}/v1\0` + value)).slice(0, 22)
```

### `src/omp/session-record.js` (pure, no I/O)

```js
classifyAgentType(relativePathSegments)   // ['proj','x.jsonl'] -> 'main'; deeper -> 'subagent'; advisor names -> 'advisor'
vocab(value)                              // vocabulary sanitizer described above; null/undefined -> null
normalizeEntry(entry, { key, sessionKey, projectKey, agentType })
// -> null | { kind: 'header', sessionId, cwd }          (raw values, caller digests them, never stored raw)
//         | { kind: 'request', record: RequestRecord }
```

`RequestRecord` (exact keys; every key always present):

```js
{
  requestKey,      // keyed(key,'request', [responseId ?? '', entry.id, msgTimestampMs, provider, model].join('\0'))
                   // no session id: branch copies of the same turn dedupe
  ts,              // ms: message.timestamp if > 0 else Date.parse(entry.timestamp); skip record if neither
  provider, api, model,          // vocab()
  upstreamProvider,              // vocab() or null
  serviceTier,                   // one of auto|default|flex|scale|priority|ultrafast, else null
  credentialId,                  // non-negative safe integer or null (omp's local credential row id)
  agentType,                     // main|subagent|advisor
  purpose,                       // 'turn' for messages; vocab(purpose) or 'auxiliary' for model_usage
  sessionKey, projectKey,        // digests from context, may be null
  stopReason,                    // stop|length|toolUse|error|aborted, else 'unrecognized'; missing -> error if errorMessage else aborted
  input, output, cacheRead, cacheWrite,   // non-negative finite integers (Math.round), missing/invalid -> null
  totalTokens,                   // provider total if valid, else sum of the four known buckets, null if all null
  costUsd,                       // usage.cost.total if finite >= 0, else null
  durationMs, ttftMs             // non-negative finite numbers or null; ttftMs > durationMs -> ttftMs null
}
```

Records without string `provider`, `model`, `api` or without a `usage` object
are skipped (return null). Entries without a non-empty string `id` are skipped.

### `src/omp/session-scanner.js`

```js
discoverSessionFiles(sessionRoots, { maxFiles = 200000 } = {})
// -> async array of { root, path, relativeSegments } for regular *.jsonl files, no symlink following
scanSessions({ store, key, sessionRoots, maxLineBytes = 32 * 1024 * 1024, signal, onProgress })
// -> { filesSeen, filesRead, requestsAdded, linesSkipped, labels: Map<projectKey, label> }
```

Per file: `fileKey = keyed(key,'file', absolutePath)`. Cursor from
`store.getCursor(fileKey)`. Re-read from 0 when dev/ino differ or size < offset;
skip when size and mtime equal the cursor. Read from `offset`, consume only
complete `\n`-terminated lines, skip (and count) lines longer than
`maxLineBytes` without buffering them, ignore unparseable lines. The header
line provides `sessionKey = keyed(key,'session', id)`,
`projectKey = keyed(key,'project', cwd)` and the label `basename(cwd)`; these are
persisted in the cursor (digests only) so later appends keep context. When
resuming at `offset > 0`, read only the first line (≤ 1 MiB) to recover the
in-memory label. Each file's new records and its new cursor are written in
one `store.commitFile(...)` transaction. `INSERT OR IGNORE` makes replay safe.

### `src/omp/quota-reader.js`

```js
importQuotaSnapshots({ store, key, agentDbPaths })
// -> { status: 'ok'|'missing'|'unavailable', added }
```

Open the first existing path with `new DatabaseSync(path, { readOnly: true })`,
`PRAGMA busy_timeout = 2000`. Read rows with `id > store.getMeta('quota_cursor:'+keyed(key,'db',path))`
ordered by id, in batches of 5000. If the table's `max(id)` is below the cursor,
restart from 0. Snapshot record:

```js
{
  snapshotKey,   // keyed(key,'snapshot', [recorded_at, provider, account_key, limit_id].join('\0'))
  recordedAt, provider: vocab, accountKey: keyed(key,'account', provider+'\0'+account_key),
  limitId: vocab, label: vocab, windowLabel: vocab|null,
  usedFraction,  // finite number >= 0 or null (may exceed 1 = overage)
  status: vocab|null, resetsAt   // ms integer or null
}
```

Missing file -> `missing`; missing table/columns or SQLite errors -> `unavailable`
(error text is not surfaced).

### `src/store.js`

```js
openStore(file)          // file ':memory:' allowed. Creates schema v1. Throws StoreVersionError
                         // (code 'store_newer') if meta.schema_version > 1. Never downgrades.
store.getMeta(k) / store.setMeta(k, v)
store.getCursor(fileKey) // -> null | { dev, ino, size, mtimeMs, offset, sessionKey, projectKey, agentType }
store.commitFile(fileKey, cursor, records)        // one transaction; returns inserted count
store.commitSnapshots(metaKey, cursorValue, snaps) // one transaction; returns inserted count
store.queryRequests({ fromMs, toMs, columns })    // iterator/array of plain objects, ts in [fromMs, toMs)
store.querySnapshots({ fromMs, toMs })            // ordered by recordedAt
store.counts()          // { requests, snapshots, files }
store.close()
```

Tables: `meta(key PK, value)`, `files(file_key PK, dev, ino, size, mtime_ms,
offset, session_key, project_key, agent_type, updated_at)`,
`requests(request_key PK, ts, provider, api, model, upstream_provider,
service_tier, credential_id, agent_type, purpose, session_key, project_key,
stop_reason, input, output, cache_read, cache_write, total_tokens, cost_usd,
duration_ms, ttft_ms)` with index on `ts`, `snapshots(snapshot_key PK,
recorded_at, provider, account_key, limit_id, label, window_label,
used_fraction, status, resets_at)` with index on `(provider, account_key,
limit_id, recorded_at)`. `queryRequests` returns camelCase keys matching
`RequestRecord`. WAL mode; file mode 0o600.

### `src/analysis/period.js`

```js
PERIODS = ['24h', '7d', '30d', 'all']
resolvePeriod(name, nowMs)        // -> { name, fromMs, toMs }; 'all' -> fromMs 0. Unknown -> throws RangeError
dayKey(ts, tzOffsetMinutes)       // 'YYYY-MM-DD' in the client's zone (offset as from Date#getTimezoneOffset, sign-inverted: pass -getTimezoneOffset())
```

### `src/analysis/usage.js`

```js
summarizeUsage(rows, { tzOffsetMinutes = 0, labels = new Map() })
```

Returns:

```js
{
  totals: Totals,
  byProvider: [{ provider, ...Totals }],
  byModel: [{ provider, model, ...Totals }],
  byCredential: [{ provider, credentialId, ...Totals }],   // credentialId null = "unattributed"
  byProject: [{ projectKey, label, ...Totals }],          // label from labels map or null
  byAgentType: [{ agentType, ...Totals }],
  byServiceTier: [{ serviceTier, ...Totals }],
  daily: [{ day, ...Totals }]                              // ascending, only days with rows
}
Totals = { requests, sessions, input, output, cacheRead, cacheWrite, totalTokens,
           costUsd, pricedRequests, unpricedRequests, errorRequests, cacheHitRate }
// costUsd sums priced rows only; cacheHitRate = cacheRead / (input + cacheRead) or null
// sessions = distinct non-null sessionKey. Lists sorted by totalTokens desc.
```

### `src/analysis/performance.js`

```js
summarizePerformance(rows, { tzOffsetMinutes = 0, serviceTier = 'all' })
```

Eligible rows: `purpose === 'turn'`, `stopReason` in stop|toolUse|length,
`output > 0`, `durationMs > 0`. Per row:
`decodeTps = output / ((durationMs - ttftMs) / 1000)` when `ttftMs != null` and
`durationMs - ttftMs >= 100`; `requestTps = output / (durationMs / 1000)`.
`serviceTier` filter: `'all'`, `'unreported'` (null), or an exact tier.

```js
{
  models: [{ provider, model, requests, timedRequests,
             decodeTps: Stats, requestTps: Stats, ttftMs: Stats,
             daily: [{ day, decodeTpsMedian, ttftMedian, n }] }],  // sorted by requests desc
  tiers: [{ serviceTier, requests }]
}
Stats = { n, median, p25, p75, mean } // all null when n = 0; percentiles by linear interpolation
```

### `src/analysis/allowance.js`

```js
summarizeAllowance(snapshots, { nowMs, staleAfterMs = 30 * 60 * 1000 })
```

Groups by `(provider, accountKey, limitId)`. For each series:

```js
{
  provider, accountKey, accountLabel,   // accountLabel = `${provider} account ${accountKey.slice(0,6)}`
  limitId, label, windowLabel,
  usedFraction, remainingFraction,      // remaining = max(0, 1 - used); null if used null
  status, resetsAt, recordedAt, ageMs, stale,
  pace: null | { ratePerHour, projectedExhaustAt, exhaustsBeforeReset, basisStartAt, basisPoints },
  history: [{ t, used }]                // last 30 days, at most 400 points (keep max per bucket)
}
```

Pace uses snapshots since the most recent reset (a drop of `usedFraction` by
more than 0.05, or a change of `resetsAt`). Requires ≥ 2 points spanning
≥ 20 minutes and a positive increase; otherwise `pace: null`. Stale series get
`pace: null`. Sort by provider, accountLabel, label.

### `src/monitor.js`

```js
createMonitor({ store, key, sources, pollMs = 5000, debounceMs = 750 })
monitor.refresh({ reason })  // single-flight; returns latest result { generation, at, sessions, quota }
monitor.start() / monitor.stop()   // fs.watch on existing session roots (recursive) + agent.db dir, plus polling fallback
monitor.on('change', ({ generation }) => ...)   // EventEmitter; emitted only when rows were added
monitor.status()   // { generation, lastRefreshAt, lastError: code|null, refreshing,
                   //   sources: { sessionRoots: [{ status: 'readable'|'missing' }], agentDb: 'ok'|'missing'|'unavailable' },
                   //   counts }
monitor.labels     // Map<projectKey, label>, in memory only
```

### `src/server.js`

```js
createServer({ monitor, store, webRoot, host = '127.0.0.1', port = 8787, now = Date.now })
// -> { listen(): Promise<{ port, url }>, close(): Promise<void> }
```

Routes (JSON unless noted; query `period` in PERIODS default `7d`, `tz` integer minutes default 0):

| Route | Response |
|---|---|
| `GET /` `/app.js` `/styles.css` | static files from `webRoot` |
| `GET /api/status` | `monitor.status()` |
| `GET /api/usage?period&tz` | `{ period, ...summarizeUsage }` |
| `GET /api/performance?period&tz&tier` | `{ period, ...summarizePerformance }` |
| `GET /api/allowance` | `{ nowMs, series: summarizeAllowance(...) }` (snapshots from the last 30 days) |
| `GET /api/overview?period&tz` | `{ period, totals, byProvider, allowance: series, topModels: perf.models.slice(0,5) }` |
| `POST /api/refresh` | requires `X-TiboTattle: 1`; `{ generation }` |
| `GET /api/events` | `text/event-stream`; `event: change` `data: {"generation":n}` on every change, comment ping every 25 s |

Errors: `{ error: '<code>' }` with 400/403/404/405/500; never echo input.

### Dashboard (`apps/web`)

Pages via hash routes: `#/overview`, `#/usage`, `#/performance`,
`#/allowance`, `#/projects`. Header has the reporting-period control (persisted
in `localStorage`, wrapped in try/catch) and a refresh button. Subscribes to
`/api/events` and refetches the current page on `change`. Charts are inline
SVG, no external assets, works offline, light and dark themes.

### Desktop (`apps/electron`)

`main.js` starts the monitor and server in-process on an ephemeral loopback
port, opens a window on it, and shows a tray whose title/tooltip is the lowest
remaining allowance. Menu: Open dashboard, Refresh now, Quit. Window uses
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and blocks
navigation and new windows outside the loopback origin.
