# User guide

TiboTattle shows how you use the [oh-my-pi](https://github.com/can1357/oh-my-pi)
(`omp`) coding agent: tokens, cost, speed and subscription allowance. It is a
macOS menu-bar app. It runs on your machine, reads omp's files without changing
them, and never uses the network. TiboTattle is not affiliated with omp.

## Requirements

- macOS 13 or newer (Apple silicon or Intel).
- omp installed and used on the same Mac. TiboTattle only reads its files.

## Install

Either:

- download `TiboTattle-macos.zip` from a run of the repository's **macOS app**
  GitHub Actions workflow (a CI build output, kept for 14 days; there are no
  published releases), unzip it and move `TiboTattle.app` to `/Applications`; or
- build it yourself on a Mac with Xcode 16:
  `apps/macos/build-app.sh`, which produces `apps/macos/dist/TiboTattle.app`.

### First launch

The app is ad-hoc signed and not notarized, so Gatekeeper blocks the first
launch. Right-click `TiboTattle.app` and choose **Open**, then confirm. Or clear
the quarantine flag once:

```sh
xattr -dr com.apple.quarantine /Applications/TiboTattle.app
```

TiboTattle has no Dock icon. Look for it in the menu bar.

### Where it looks for omp's data

By default `~/.omp/agent`. If omp keeps its data elsewhere, TiboTattle follows
omp's own `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` variables, but only when
they are present in the app's environment. An app started from Finder or as a
login item usually does not see variables exported in your shell profile. No
other location is searched.

## The menu bar and popover

- The menu bar shows the lowest remaining allowance among fresh readings, such
  as `62%` (`62%?` when every reading is stale), or only an icon when omp has
  recorded no allowance.
- Click it for allowance meters with reset countdowns and pace, totals for the
  chosen period (requests, tokens, cost with unpriced requests, cache hit
  rate) and the top five models with median decode speed and TTFT. The period
  picker (24h, 7d, 30d, All) is remembered.
- **Open Dashboard** shows the full dashboard in a window. It is served from
  inside the app; no web server or network port is opened. Closing the window
  frees its memory; the app keeps running in the menu bar.
- **Refresh** re-scans immediately. Otherwise the app updates within about a
  second of omp writing, and at least every minute.
- **Start at login** registers the app as a login item (macOS may ask you to
  approve it in System Settings › General › Login Items). **Quit** stops it.

If the index was written by a newer TiboTattle, the popover says so
(`store_newer`) and the index is left unchanged. Update the app.

## Dashboard pages

Choose the reporting period (24 h, 7 d, 30 d or all) in the header; the choice
is remembered while the app runs. The page refreshes itself when omp writes new
data (it falls back to polling), and **Refresh** forces a re-scan.

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
checks a subscription provider's usage limits. It therefore appears only when
omp records `usage_history` (subscription providers whose usage omp fetches);
API-key usage has no allowance, and without any snapshot the menu bar shows
only an icon. TiboTattle shows the latest reading per account and window; a
reading older than 30 minutes is marked stale.

The pace forecast uses readings since the most recent reset (a drop in used
share of more than 5 points, or a changed reset time). It needs at least two
readings at least 20 minutes apart with rising usage, and is not shown for
stale series. When it is shown, "Projected empty" gives the time the window
would run out at the recent rate, and the page says whether that is before the
reset.

Accounts are shown as `provider account abc123`, a short local digest; the
real account identifier is never stored.

## Delete your data

1. Turn off **Start at login**, then **Quit** TiboTattle.
2. Delete `~/Library/Application Support/TiboTattle` (or the directory in
   `TIBOTATTLE_STATE_DIR` if you set it).
3. Optionally: `defaults delete io.github.aloyzzz.tibotattle`.
4. Delete `TiboTattle.app`.

omp's own files are never touched. See
[the privacy reference](reference/privacy.md) for exactly what is read and
stored.

## Troubleshooting

[SUPPORT.md](../SUPPORT.md) lists common causes (nothing shown, empty
allowance, `store_newer`).
