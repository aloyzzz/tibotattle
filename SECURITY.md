# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/aloyzzz/tibotattle/security/advisories/new).
Do not open a public issue for a security problem.

Include the TiboTattle version or commit, your operating system and Node.js
version, and steps to reproduce. Use synthetic data only: never attach real omp
session files, `agent.db`, prompts, responses, paths or account details.

Reports are handled on a best-effort basis by the maintainer. There is no paid
bug bounty.

## Supported versions

Only the latest commit on the default branch (currently 0.2.x, the omp
edition) receives fixes. The retired Codex edition (0.1.x) and its hosted
service, community sharing and installers are no longer maintained.

## Security model

TiboTattle runs entirely on your machine.

- **No network.** It makes no outbound requests. The desktop shell cancels any
  renderer request outside its own loopback origin.
- **Loopback server.** The dashboard server binds `127.0.0.1` only, rejects
  requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`
  (DNS-rebinding defense), sends a same-origin-only Content-Security-Policy
  (`default-src 'self'`, no framing, no form posts), and requires the `X-TiboTattle: 1` header on mutating routes (cross-site
  request defense). Any local process that can reach the port can read the
  dashboard API, just as it could read omp's files directly.
- **Read-only access to omp.** Session logs are read; `agent.db` is opened
  read-only and only the `usage_history` table is queried. Credentials stored
  by omp (`auth_credentials`) are never read.
- **Content-free index.** The index holds token counts, costs, timings,
  sanitized vocabulary and keyed digests. See
  [the privacy reference](docs/reference/privacy.md).
- **Local key.** A random 32-byte key in `identity.key` (mode `0600`) keys the
  digests. The state directory is created with mode `0700`.
- **Electron hardening.** `contextIsolation`, `sandbox`, no `nodeIntegration`,
  no preload, no webviews, all permission requests denied, new windows and
  off-origin navigation blocked.

## In scope

- Anything that sends data off the machine.
- Exposure of the server beyond loopback, Host or CSRF bypasses.
- Session content, paths, emails, raw account keys or credentials reaching the
  index, logs, API responses, errors or the dashboard.
- Writes to omp's files, or reads of omp tables other than `usage_history`.
- Renderer escapes or navigation to untrusted origins in the desktop shell.

## Out of scope

- Attacks that require an already-compromised user account on the same machine.
- Accuracy of omp's own cost estimates or of provider-reported allowance.
