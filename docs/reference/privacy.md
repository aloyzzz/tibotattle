# Privacy reference

This page states exactly what TiboTattle (omp edition, 0.2.x) reads, what it
stores, what it never stores, and how to delete it. The authoritative module
contracts are in [architecture.md](architecture.md); the code and tests are the
final authority on implemented behavior.

## No network

TiboTattle makes no outbound network requests. There is no telemetry, crash
upload, update check, sign-in, sharing or hosted service. The dashboard loads
no remote fonts, scripts or images. The desktop shell cancels every renderer
request that is not to its own `127.0.0.1` origin and opens no external links.

The dashboard server listens on `127.0.0.1` only, rejects requests whose `Host`
header is not `127.0.0.1:<port>` or `localhost:<port>`, and requires the header
`X-TiboTattle: 1` on `POST /api/refresh`.

## What is read

All reads are read-only. omp's files are never modified.

| File | What is used |
|---|---|
| `<agent>/sessions/**/*.jsonl` (omp session logs) | The session header (`id`, `timestamp`, `cwd`) and, for entries of type `message` with role `assistant` and type `model_usage`: entry `id` and `timestamp`, `api`, `provider`, `model`, `usage` token counts and `cost`, `stopReason`, `duration`, `ttft`, `serviceTier`, `credentialId`, `responseId`, `upstreamProvider`, `purpose`. Every other entry type is ignored. |
| `<agent>/agent.db`, table `usage_history` | Columns `id, recorded_at, provider, account_key, limit_id, label, window_label, used_fraction, status, resets_at`. |

`<agent>` is `$PI_CODING_AGENT_DIR`, else `~/<$PI_CONFIG_DIR or .omp>/agent`,
plus `$XDG_DATA_HOME/omp` on Linux when it exists, or the `--agent-dir` flag.

Each session line is parsed with `JSON.parse` so its type can be checked. The
message `content` (prompts, responses, tool calls and results) is never
inspected, copied or stored. In `agent.db`, the `email` and `account_id`
columns and every other table, including `auth_credentials`, are never read.

## What is stored

Everything lives in the state directory:

| Platform | Default state directory |
|---|---|
| macOS | `~/Library/Application Support/TiboTattle` |
| Windows | `%APPDATA%\TiboTattle` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/tibotattle` |

`TIBOTATTLE_STATE_DIR` or `--state-dir` overrides it. The directory is created
with mode `0700`.

| File | Contents |
|---|---|
| `identity.key` | 32 random bytes (mode `0600`) used to key digests. Never leaves the machine. |
| `index.sqlite` (+ `-wal`, `-shm`) | The index described below (mode `0600`). |

The desktop shell uses its Electron user-data folder as the state directory, so
Chromium's own profile files (for example local storage holding the selected
reporting period) also live there.

The native macOS app uses the same macOS state directory, key and index as the
CLI. Outside it, the app stores only its popover period choice and dashboard
window position in its macOS preferences (`io.github.aloyzzz.tibotattle`) and,
if you turn it on, a login item registered with macOS. Its dashboard web view
uses a non-persistent WebKit data store, so page storage is kept in memory and
discarded when the window closes. The web view refuses any navigation outside
`tibotattle://app/`, and the app opens no network socket.

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
- **Metadata**: schema version and the `usage_history` read cursor.

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
rebuilt from session headers at startup, held only in memory, and served only
to the loopback dashboard.

CLI and API errors are fixed codes such as `store_newer` or `forbidden_host`.
`doctor` prints status words and shows paths only with `--show-paths`.

## How to delete

1. Quit TiboTattle (CLI or desktop).
2. Delete the state directory listed above (or the one you set).

That removes everything TiboTattle stored. omp's own files are untouched; if
TiboTattle runs again it rebuilds the index from them. Removing the desktop app
does not remove its state directory; delete it as above. For the native macOS
app, also turn off Start at login before deleting the app and, optionally, run
`defaults delete io.github.aloyzzz.tibotattle`.
