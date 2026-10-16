# Contributing

Thanks for helping improve TiboTattle. This edition is a small, dependency-free
Node.js project that monitors the omp coding agent locally.

## Before you start

- Read [AGENTS.md](AGENTS.md) for invariants and
  [docs/reference/architecture.md](docs/reference/architecture.md) for module
  contracts.
- For larger changes, open an issue first so the approach can be agreed.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

```sh
git clone https://github.com/aloyzzz/tibotattle.git
cd tibotattle
npm test            # Node.js 22.13+, no install needed
npm start           # dashboard on http://127.0.0.1:8787/
npm install         # only needed for the Electron desktop shell
npm run desktop
```

## Guidelines

- Keep runtime dependencies at zero. Use Node.js built-ins.
- Keep changes focused. Update tests and the affected docs in the same change.
- Never send data off the machine and never widen what is read from omp
  without a decision record in `docs/decisions/`.
- Missing values stay `null`; do not turn absent evidence into zero.
- Errors surfaced to users are fixed codes, never paths or stack traces.

## Tests and fixtures

- `npm test` runs all suites with `node:test`, serially.
- Fixtures must be synthetic and content-free: invented session IDs, invented
  paths such as `/synthetic/project`, no real prompts, responses, emails or
  account identifiers. Never commit a real omp session file or `agent.db`.
- Prefer small fixtures that exercise one structural boundary.

## Pull requests

- Describe what changed and why, and how you verified it.
- Confirm that the change (code, fixtures, commits, description and
  screenshots) contains no prompts, responses or real paths from coding-agent
  sessions.
- Say which platforms you exercised. A Linux run does not prove macOS or
  Windows tray behavior.

By contributing you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE).
