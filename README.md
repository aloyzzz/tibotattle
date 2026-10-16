# TiboTattle

Local-first usage, cost, allowance and speed monitoring for the
[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) coding agent.

TiboTattle reads omp's own session logs and the subscription-usage snapshots
omp records, keeps a small content-free index on your machine, and serves a
dashboard on `127.0.0.1`. It has no hosted service, no community sharing, no
accounts, no updater and makes no outbound network requests.

> TiboTattle is an independent project. It is not affiliated with or endorsed
> by omp, its author Can Bölük, or Mario Zechner's pi, which omp is forked
> from. The name dates from the retired Codex edition of this project.

## What it shows

- **Overview**: requests, tokens, cost and the lowest remaining allowance at a
  glance for the selected period (24 h, 7 d, 30 d or all).
- **Usage & cost**: tokens by input, output, cache read and cache write; cost
  as omp recorded it; breakdowns by provider, model, credential, agent type
  (main, subagent, advisor) and service tier; a daily series.
- **Model performance**: median and interquartile decode tokens per second and
  time to first token per model, with a daily trend and a service-tier filter.
- **Allowance**: remaining fraction per subscription account and limit window,
  reset time, staleness and a pace forecast.
- **Projects**: usage per project, labelled by the working directory's final
  folder name (held in memory only, never stored).

Missing evidence stays visible as missing: a request without a recorded cost is
"unpriced" rather than $0, and a request without timing is left out of speed
statistics rather than counted as zero.

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`).
- omp installed and used on the same machine. TiboTattle only reads its files.
- Optional: Electron 38 (the only dev dependency) for the desktop tray app.

There are no runtime npm dependencies.

## Quick start

```sh
git clone https://github.com/aloyzzz/tibotattle.git
cd tibotattle
npm start            # index omp sessions and serve http://127.0.0.1:8787/
```

Other commands:

```sh
node bin/tibotattle.js scan                    # refresh the index once
node bin/tibotattle.js report --period 30d     # text summary (or --json)
node bin/tibotattle.js doctor                  # check sources, Node.js, SQLite
node bin/tibotattle.js serve --port 0          # any free loopback port
```

Desktop tray app (installs Electron as a dev dependency):

```sh
npm install
npm run desktop
```

See [the user guide](docs/user-guide.md) for the pages, how speed is measured
and where allowance data comes from.

## Where data comes from

| Source | Default location | Used for |
|---|---|---|
| omp session logs | `~/.omp/agent/sessions/**/*.jsonl` | tokens, cost, timing, model, provider |
| omp `usage_history` | `~/.omp/agent/agent.db` (read-only) | subscription allowance snapshots |

`PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `XDG_DATA_HOME/omp` on Linux, and the
`--agent-dir` flag change the location. Allowance appears only for subscription
providers whose usage omp itself fetches.

TiboTattle's index lives in its state directory (`TIBOTATTLE_STATE_DIR`, or
`~/Library/Application Support/TiboTattle`, `%APPDATA%\TiboTattle`,
`~/.local/state/tibotattle`). Deleting that directory removes everything
TiboTattle has stored. The [privacy reference](docs/reference/privacy.md) lists
exactly what is read and stored.

## Development

```sh
npm test
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before
changing code, and [the architecture reference](docs/reference/architecture.md)
for module contracts. Security reports go through
[SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
