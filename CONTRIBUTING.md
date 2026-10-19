# Contributing

Thanks for helping improve TiboTattle. It is a small native macOS menu-bar app,
written in Swift with system frameworks only, that monitors the omp coding
agent locally.

## Before you start

- Read [AGENTS.md](AGENTS.md) for invariants and
  [docs/reference/architecture.md](docs/reference/architecture.md) for module
  contracts.
- For larger changes, open an issue first so the approach can be agreed.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

You need a Mac with macOS 13+ and Xcode 16 (Swift 6 toolchain).

```sh
git clone https://github.com/aloyzzz/tibotattle.git
cd tibotattle/apps/macos
swift build
swift test
./build-app.sh      # -> dist/TiboTattle.app and TiboTattle-macos.zip
```

Swift code builds and tests only on macOS. If you do not have a Mac, open the
pull request and rely on the `macOS app` workflow
(`.github/workflows/macos-app.yml`), and say that you did not compile locally.

## Guidelines

- Use system frameworks only; do not add Swift packages.
- Keep changes focused. Update tests and the affected docs in the same change.
- Never send data off the machine and never widen what is read from omp
  without a decision record in `docs/decisions/`.
- Missing values stay `null`; do not turn absent evidence into zero.
- Errors surfaced to users are fixed codes, never paths or stack traces.
- The dashboard in `apps/web` is plain HTML, CSS and JavaScript with no build
  step and no external assets; XCTest checks it statically.

## Tests and fixtures

- `swift test` (in `apps/macos`) runs all suites.
- Fixtures must be synthetic and content-free: invented session IDs, invented
  paths such as `/synthetic/project`, no real prompts, responses, emails or
  account identifiers. Never commit a real omp session file or `agent.db`.
- The golden vectors in `apps/macos/Tests/TiboTattleCoreTests/Fixtures/golden`
  are frozen. They cannot be regenerated; changing one is a deliberate hand
  edit that needs a decision record.
- Prefer small fixtures that exercise one structural boundary.

## Pull requests

- Describe what changed and why, and how you verified it.
- Confirm that the change (code, fixtures, commits, description and
  screenshots) contains no prompts, responses or real paths from coding-agent
  sessions.
- Say what you actually ran: `swift build` and `swift test` on macOS, or CI
  only. Do not report a check as passing if it did not run.

By contributing you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE).
