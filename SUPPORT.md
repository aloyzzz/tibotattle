# Support

TiboTattle is maintained on a best-effort basis. There is no hosted service,
account or paid support.

## Self-check first

Click the TiboTattle menu-bar item. The top of the popover shows when the data
was last updated and, in orange, any problem found:

| Message or symptom | Likely cause |
|---|---|
| `omp session folder not found` | omp keeps its data elsewhere. TiboTattle looks in `~/.omp/agent` and follows `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`, but only if they are in the app's environment (an app started from Finder usually does not see your shell profile) |
| `omp agent.db not found, so no allowance data` | omp has not created `agent.db` yet, or it lives elsewhere (see above) |
| `omp agent.db could not be read` | the database is locked, unreadable or lacks the `usage_history` table or columns |
| No allowance data | omp only records `usage_history` for subscription providers whose usage it checks |
| Cost shows "unpriced" | omp did not record a cost for those requests |
| No speed figures | requests lacked duration or TTFT, or did not finish normally |
| `store_newer` | the index was written by a newer TiboTattle; update the app instead of downgrading |
| `state_dir_unavailable`, `key_invalid`, `key_unreadable`, `key_unwritable`, `store_unavailable` | the state directory, `identity.key` or `index.sqlite` could not be opened; check permissions, or delete the state directory to start over |
| The app is blocked on first launch | it is ad-hoc signed and not notarized: right-click → **Open**, or `xattr -dr com.apple.quarantine /path/to/TiboTattle.app` |

TiboTattle requires macOS 13 or newer. Linux and Windows are not supported.

To start over, quit TiboTattle and delete its state directory (see
[the privacy reference](docs/reference/privacy.md)). The index is rebuilt from
omp's files on the next run.

## Getting help

- Questions and bugs: open an issue at
  <https://github.com/aloyzzz/tibotattle/issues> using the templates.
- Security problems:
  [private advisory](https://github.com/aloyzzz/tibotattle/security/advisories/new).
- Problems with omp itself belong in omp's own repository; TiboTattle is not
  affiliated with omp.

Never include prompts, model responses, real file paths, emails or account
details in an issue. Use synthetic examples.
