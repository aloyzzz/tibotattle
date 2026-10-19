# Documentation

Current documentation for TiboTattle 0.3.x, the native macOS app. Code and
tests are the authority on implemented behavior; these pages describe the
contracts and must be updated in the same change when a contract moves.

| Page | Purpose |
|---|---|
| [user-guide.md](user-guide.md) | Install, first launch, menu bar, popover and dashboard, how speed and allowance are measured, deleting data |
| [reference/architecture.md](reference/architecture.md) | Swift modules, data flow, omp sources, index schema, analysis definitions, in-process API |
| [reference/macos-app.md](reference/macos-app.md) | App shell, Swift package and public API, frozen golden vectors, tests |
| [reference/privacy.md](reference/privacy.md) | Exactly what is read, stored and never stored; how to delete |
| [decisions/2026-10-19-native-macos-only.md](decisions/2026-10-19-native-macos-only.md) | Why the Node implementation and Electron shell were removed |
| [decisions/2026-10-17-native-macos-app.md](decisions/2026-10-17-native-macos-app.md) | Why macOS got a native Swift app (partly superseded) |
| [decisions/2026-10-16-omp-edition.md](decisions/2026-10-16-omp-edition.md) | Why the Codex edition and its hosted surface were retired (partly superseded) |

Repository-level guides: [README](../README.md),
[CONTRIBUTING](../CONTRIBUTING.md), [SECURITY](../SECURITY.md),
[SUPPORT](../SUPPORT.md), [CHANGELOG](../CHANGELOG.md) and the agent guidance in
[AGENTS.md](../AGENTS.md).

Decision records in `decisions/` are dated and kept as the reasoning behind
current invariants. The retired Node.js implementation, command-line tool and
Electron shell are in git history at commit `f140a49`; documentation for the
retired Codex edition (plans, audits, receipts, runbooks) lives only in git
history.
