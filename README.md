# TiboTattle

Local-first usage, cost, allowance and speed monitoring for the
[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) coding agent, as a
native macOS menu-bar app.

TiboTattle reads omp's own session logs and the subscription-usage snapshots
omp records, keeps a small content-free index on your Mac, and shows the result
in a menu-bar popover and a dashboard window. It has no hosted service, no
sharing, no accounts, no updater, opens no network socket and makes no outbound
network requests.

> TiboTattle is an independent project. It is not affiliated with or endorsed
> by omp, its author Can Bölük, or Mario Zechner's pi, which omp is forked
> from. The name dates from the retired Codex edition of this project.

## What it shows

- **Menu bar**: the lowest remaining allowance, such as `62%` (`62%?` when every
  reading is stale).
- **Popover**: allowance meters with reset countdowns and pace, totals for the
  selected period (24h, 7d, 30d, all), and the top models by median decode
  speed and time to first token.
- **Dashboard window**: Overview, Usage & cost, Model performance, Allowance
  and Projects pages.

Missing evidence stays visible as missing: a request without a recorded cost is
"unpriced" rather than $0, and a request without timing is left out of speed
statistics rather than counted as zero.

## Requirements

- macOS 13 or newer (universal: Apple silicon and Intel).
- omp installed and used on the same Mac. TiboTattle only reads its files.
- To build from source: Xcode 16 (Swift 6 toolchain). No packages or other
  dependencies.

## Build and test

```sh
cd apps/macos
swift build
swift test
```

```sh
apps/macos/build-app.sh   # -> apps/macos/dist/TiboTattle.app and TiboTattle-macos.zip
```

Every run of the [macOS app workflow](.github/workflows/macos-app.yml) also
attaches `TiboTattle-macos.zip` as a build artifact (kept 14 days). It is a CI
build output, not a release.

The app is ad-hoc signed and not notarized, so Gatekeeper blocks the first
launch. Right-click the app and choose **Open**, or clear the quarantine flag:

```sh
xattr -dr com.apple.quarantine /path/to/TiboTattle.app
```

See [the user guide](docs/user-guide.md) for the pages, how speed is measured
and where allowance data comes from.

## Privacy

- Reads omp's session logs and the `usage_history` table of `agent.db`,
  read-only. Prompts, responses, tool calls, file paths, emails and credentials
  are never read into the index.
- The index holds token counts, costs, timings, sanitized model and provider
  names and keyed digests, in `~/Library/Application Support/TiboTattle`.
- No telemetry, no update checks, no remote assets. The dashboard is served
  inside the app on `tibotattle://app/`; there is no listening socket.

Deleting the state directory removes everything TiboTattle has stored. The
[privacy reference](docs/reference/privacy.md) lists exactly what is read and
stored.

## Where data comes from

| Source | Default location | Used for |
|---|---|---|
| omp session logs | `~/.omp/agent/sessions/**/*.jsonl` | tokens, cost, timing, model, provider |
| omp `usage_history` | `~/.omp/agent/agent.db` (read-only) | subscription allowance snapshots |

`PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` (when set in the app's environment)
change the location. Allowance appears only when omp records `usage_history`,
which it does for subscription providers whose usage it fetches.

## Layout

| Path | Contents |
|---|---|
| `apps/macos/` | the app: `Sources/TiboTattleCore` (engine), `Sources/TiboTattle` (UI), `Tests`, `Resources`, `build-app.sh` |
| `apps/web/` | the dashboard (plain HTML, CSS and JS), bundled into the app |
| `docs/` | user guide, architecture and privacy references, decision records |

The earlier Node.js implementation, command-line tool and Electron shell were
removed; they remain in git history at commit `f140a49`.

## Development

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before
changing code, and [the architecture reference](docs/reference/architecture.md)
for module contracts. Security reports go through
[SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
