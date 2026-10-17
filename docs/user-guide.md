# User guide

TiboTattle shows how you use the [oh-my-pi](https://github.com/can1357/oh-my-pi)
(`omp`) coding agent: tokens, cost, speed and subscription allowance. It runs
on your machine, reads omp's files without changing them, and never uses the
network. TiboTattle is not affiliated with omp.

## Install from source

You need Node.js 22.13 or newer and omp on the same machine.

```sh
git clone https://github.com/aloyzzz/tibotattle.git
cd tibotattle
npm start
```

`npm start` indexes your omp sessions, keeps watching for new ones, and prints
the dashboard address, normally <http://127.0.0.1:8787/>. Press Ctrl+C to stop.
No `npm install` is needed for the CLI or the dashboard.

If omp keeps its data somewhere other than `~/.omp/agent`, TiboTattle follows
omp's own `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` variables (and
`$XDG_DATA_HOME/omp` on Linux), or you can pass `--agent-dir DIR`.

### Command line

| Command | What it does |
|---|---|
| `node bin/tibotattle.js serve [--port N]` | Index, watch and serve the dashboard (`--port 0` picks a free port) |
| `node bin/tibotattle.js scan` | Refresh the index once and print counts |
| `node bin/tibotattle.js report [--period 24h\|7d\|30d\|all] [--json]` | Print totals, providers, models with median decode speed and TTFT, and allowance |
| `node bin/tibotattle.js doctor [--show-paths]` | Check omp sources, Node.js, SQLite and the index |

Every command accepts `--agent-dir DIR` and `--state-dir DIR`.

### Desktop app

```sh
npm install        # installs Electron, the only dev dependency
npm run desktop
```

The desktop app runs the same monitor and dashboard in one window and adds a
tray icon. On macOS the tray title shows the lowest remaining allowance, such
as `7d 63%` (a trailing `?` means the reading is stale); elsewhere it is in the
tooltip. The tray menu has **Open dashboard**, **Refresh now**, **Start at
login** (macOS and Windows) and **Quit**. Closing the window on macOS keeps the
app in the tray. There is no installer and no automatic update.

### Native macOS app

On macOS 13 or newer you can use the native menu-bar app instead of the CLI or
Electron. It is one small universal app that uses only frameworks built into
macOS; it needs no Node.js.

Build it with `apps/macos/build-app.sh` (Xcode 16 or its command-line tools),
or download `TiboTattle-macos.zip` from a run of the repository's **macOS app**
CI workflow. Move `TiboTattle.app` to `/Applications`. The app is ad-hoc signed
and not notarized, so the first launch needs right-click → **Open**, or
`xattr -dr com.apple.quarantine /Applications/TiboTattle.app`.

- The menu bar shows the lowest remaining allowance, such as `62%` (`62%?`
  when every reading is stale), or only an icon when omp has recorded no
  allowance.
- Click it for allowance meters with reset countdowns and pace, totals for the
  chosen period (requests, tokens, cost with unpriced requests, cache hit
  rate) and the top five models with median decode speed and TTFT. The period
  choice is remembered.
- **Open Dashboard** shows the full dashboard in a window. It is served from
  inside the app; no web server or network port is opened. Closing the window
  frees its memory; the app keeps running in the menu bar.
- **Refresh** re-scans immediately; otherwise the app updates within about a
  second of omp writing, and at least every minute.
- **Start at login** registers the app as a login item (macOS may ask you to
  approve it in System Settings › General › Login Items). **Quit** stops it.

The app uses the same state directory and index as the CLI
(`~/Library/Application Support/TiboTattle`, or `TIBOTATTLE_STATE_DIR`), and
follows `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` like the CLI when they are
set in its environment. If the index was written by a newer TiboTattle, the
app shows `store_newer` and leaves the index unchanged.

## Dashboard pages

Choose the reporting period (24 h, 7 d, 30 d or all) in the header; the choice
is remembered in this browser. The page refreshes itself when omp writes new
data, and **Refresh** forces a re-scan.

- **Overview**: totals for the period, cost by provider, the allowance meters
  and the top models by requests.
- **Usage & cost**: tokens per day, cost per day, and breakdowns by provider,
  model, credential, agent type (main agent, subagent, advisor) and service
  tier. Each chart has a data table view.
- **Model performance**: per model, median and interquartile decode speed,
  request speed and time to first token, with daily trends. Filter by service
  tier, including "not reported".
- **Allowance**: one meter per account and limit window with remaining share,
  reset time, last reading, a used-over-time chart and a pace forecast.
- **Projects**: usage per project, labelled by the working directory's final
  folder name. Labels are kept in memory only.

### Cost

Cost is the `usage.cost.total` that omp recorded on each message, using omp's
own model prices. It is an estimate, not your provider's bill. Requests omp did
not price are counted as **unpriced** and excluded from cost totals; they are
never treated as $0. A cost followed by `+` means some requests in that row are
unpriced.

Cache hit rate is cache-read tokens divided by input plus cache-read tokens.

### How speed (TPS) and TTFT are measured

omp records, on each assistant message, the request `duration` and the time to
first token `ttft`, in milliseconds, from its own client-side timing. They
therefore include network latency and provider queueing.

A request counts toward speed statistics only when it is a normal turn (not an
auxiliary call such as title generation), finished with `stop`, `toolUse` or
`length`, produced output tokens, and has a positive duration.

- **Decode speed** = output tokens / ((duration − TTFT) / 1 s). It needs a
  recorded TTFT and at least 100 ms between first token and the end; otherwise
  that request has no decode speed.
- **Request speed** = output tokens / (duration / 1 s), including the wait for
  the first token.
- **TTFT** is reported as omp recorded it. A TTFT larger than the duration is
  discarded.

Output tokens include reasoning tokens, so models that think before answering
show their full generation rate. Figures are medians with the 25th and 75th
percentiles; requests without timing are left out, never counted as zero.

### Allowance

Allowance comes from omp's `usage_history` table, which omp fills when it
checks a subscription provider's usage limits. It therefore appears only for
subscription providers whose usage omp fetches; API-key usage has no
allowance. TiboTattle shows the latest reading per account and window; a
reading older than 30 minutes is marked stale.

The pace forecast uses readings since the most recent reset (a drop in used
share of more than 5 points, or a changed reset time). It needs at least two
readings at least 20 minutes apart with rising usage, and is not shown for
stale series. When it is shown, "Projected empty" gives the time the window
would run out at the recent rate, and the page says whether that is before the
reset.

Accounts are shown as `provider account abc123`, a short local digest; the
real account identifier is never stored.

## Troubleshooting and privacy

Run `node bin/tibotattle.js doctor` first; [SUPPORT.md](../SUPPORT.md) lists
common causes. [The privacy reference](reference/privacy.md) lists exactly
what is read and stored and how to delete it.
