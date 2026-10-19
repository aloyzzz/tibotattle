# Privacy reference

This page states exactly what TiboTattle (the native macOS app) reads, what it
stores, what it never stores, and how to delete it. The module contracts are in
[architecture.md](architecture.md); the code and tests are the final authority
on implemented behavior.

## No network

TiboTattle makes no outbound network requests. There is no telemetry, crash
upload, update check, sign-in, sharing or hosted service. The dashboard loads
no remote fonts, scripts or images.

The app opens no listening socket and runs no HTTP server. The dashboard is a
`WKWebView` on the custom scheme `tibotattle://app/`; its pages and its
`/api/*` data are produced inside the app process. The web view cancels every
navigation outside `tibotattle://app/` and refuses new windows. Responses on
that scheme carry a strict `Content-Security-Policy` (`default-src 'self'`
family) and related headers. `POST /api/refresh` requires the header
`X-TiboTattle: 1`.

## What is read

All reads are read-only. omp's files are never modified.

| File | What is used |
|---|---|
| `<agent>/sessions/**/*.jsonl` (omp session logs) | The session header (`id`, `timestamp`, `cwd`) and, for entries of type `message` with role `assistant` and type `model_usage`: entry `id` and `timestamp`, `api`, `provider`, `model`, `usage` token counts and `cost`, `stopReason`, `errorMessage` (only whether it is a non-empty string), `duration`, `ttft`, `serviceTier`, `credentialId`, `responseId`, `upstreamProvider`, `purpose`. Every other entry type is ignored. |
| `<agent>/agent.db`, table `usage_history` | Columns `id, recorded_at, provider, account_key, limit_id, label, window_label, used_fraction, status, resets_at`. |

`<agent>` is `$PI_CODING_AGENT_DIR`, else `~/<$PI_CONFIG_DIR or .omp>/agent`.
These variables are read from the app's own process environment; no other
location (for example XDG directories) is consulted.

Each session line is parsed as JSON so its type can be checked. The message
`content` (prompts, responses, tool calls and results) is never inspected,
copied or stored. In `agent.db`, the `email` and `account_id` columns and every
other table, including `auth_credentials`, are never read.

## What is stored

Everything TiboTattle writes lives in the state directory, plus two macOS
preferences and an optional login item.

| Item | Location |
|---|---|
| State directory | `~/Library/Application Support/TiboTattle`, or the directory in `$TIBOTATTLE_STATE_DIR` if that is set in the app's environment. Created with mode `0700`. |
| `identity.key` | 32 random bytes (mode `0600`) used to key digests. Never leaves the machine. |
| `index.sqlite` (+ `-wal`, `-shm`) | The index described below (mode `0600`). |
| Preferences | `io.github.aloyzzz.tibotattle` (macOS `UserDefaults`): the popover's selected period and the dashboard window's saved frame (position and size). |
| Login item | Registered with macOS (`SMAppService`) only if you turn on **Start at login**. |

The dashboard's web view uses a non-persistent WebKit data store, so page
storage (such as the dashboard's remembered reporting period) is kept in memory
and discarded when the app quits. Nothing WebKit-side is written to disk.

The index holds:

- **Per request**: timestamp; provider, api, model, upstream provider, service
  tier, stop reason and purpose as sanitized vocabulary; omp's local credential
  row number; agent type (main, subagent, advisor); input, output, cache-read,
  cache-write and total tokens; cost as recorded by omp; duration and time to
  first token; keyed digests of the request, session and project.
- **Per allowance snapshot**: recorded time, provider, limit id, label and
  window label (vocabulary), used fraction, status, reset time, and keyed
  digests of the snapshot and account.
- **Per session file**: a keyed digest of its path, file identity (device,
  inode, size, mtime), read offset, and the session and project digests.
- **Metadata**: schema version and the `usage_history` read cursor (a row id
  and a timestamp).

A keyed digest is the first 22 characters of base64url HMAC-SHA256 under the
local key. Without `identity.key` a digest cannot be linked back to its input.
Vocabulary values that do not match `^[A-Za-z0-9._:/@+ -]{1,128}$` are stored as
`unrecognized`.

## What is never stored

Prompts, responses, reasoning text, tool calls and results, file paths, file
names, working directories, emails, raw account keys or IDs, session IDs,
credentials and tokens of any kind never enter the index, logs, API responses
or error messages.

Project labels (the final folder name of a session's working directory) are
rebuilt from session headers, held only in memory, and passed only to the
in-process API that feeds the dashboard.

Errors are fixed codes such as `store_newer` or `bad_period`. Paths, input and
SQLite messages are not shown.

## How to delete

1. Turn off **Start at login** in the popover, then choose **Quit**.
2. Delete the state directory (`~/Library/Application Support/TiboTattle`, or
   the one you set with `TIBOTATTLE_STATE_DIR`).
3. Optionally remove the preferences:
   `defaults delete io.github.aloyzzz.tibotattle`.
4. Delete `TiboTattle.app`.

That removes everything TiboTattle stored. omp's own files are untouched; if
TiboTattle runs again it rebuilds the index from them. Deleting the app alone
does not remove the state directory or the preferences.
