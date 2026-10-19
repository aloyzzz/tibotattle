# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/aloyzzz/tibotattle/security/advisories/new).
Do not open a public issue for a security problem.

Include the TiboTattle version or commit, your macOS version and Mac
architecture, and steps to reproduce. Use synthetic data only: never attach
real omp session files, `agent.db`, prompts, responses, paths or account
details.

Reports are handled on a best-effort basis by the maintainer. There is no paid
bug bounty.

## Supported versions

Only the latest commit on the default branch (the native macOS app, 0.3.x)
receives fixes. The Node.js implementation, command-line tool and Electron
desktop shell were removed and remain only in git history (commit `f140a49`);
they are not maintained. The retired Codex edition (0.1.x) and its hosted
service, community sharing and installers are not maintained either.

## Security model

TiboTattle is a macOS app that runs entirely on your machine.

- **No network.** It makes no outbound requests and opens no listening socket
  or HTTP server. The dashboard is a web view on the custom scheme
  `tibotattle://app/`; its pages and `/api/*` data are produced inside the app
  process. The web view cancels every navigation outside `tibotattle://app/`,
  refuses new windows, has no script message handlers, and uses a
  non-persistent data store. Responses on the scheme carry a same-origin-only
  Content-Security-Policy (`default-src 'self'`, no framing, no form posts),
  and `POST /api/refresh` requires the header `X-TiboTattle: 1`.
- **Read-only access to omp.** Session logs are read; `agent.db` is opened
  read-only and only the `usage_history` columns listed in
  [the architecture reference](docs/reference/architecture.md) are selected.
  Credentials stored by omp (`auth_credentials`) are never read.
- **Content-free index.** The index holds token counts, costs, timings,
  sanitized vocabulary and keyed digests. See
  [the privacy reference](docs/reference/privacy.md).
- **Local key.** A random 32-byte key in `identity.key` (mode `0600`) keys the
  digests. The state directory is created with mode `0700` and the index with
  mode `0600`.
- **Signing.** Builds are ad-hoc signed with the hardened runtime and are not
  notarized. CI artifacts are test builds, not releases.

## In scope

- Anything that sends data off the machine, or opens a socket.
- Navigation or requests from the dashboard web view to origins other than
  `tibotattle://app/`, or script injection into the dashboard.
- Session content, paths, emails, raw account keys or credentials reaching the
  index, logs, API responses, errors or the dashboard.
- Writes to omp's files, or reads of omp tables other than `usage_history`.

## Out of scope

- Attacks that require an already-compromised user account on the same machine.
- Accuracy of omp's own cost estimates or of provider-reported allowance.
