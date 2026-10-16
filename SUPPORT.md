# Support

TiboTattle is maintained on a best-effort basis. There is no hosted service,
account or paid support.

## Self-check first

```sh
node bin/tibotattle.js doctor
```

`doctor` reports, using status words only, whether omp's session directory and
`agent.db` were found and are readable, the Node.js version, whether
`node:sqlite` is available, and the index counts. Add `--show-paths` to see the
locations it checked; remove those paths before sharing the output.

Common situations:

| Symptom | Likely cause |
|---|---|
| `sessions[0] missing` | omp keeps its data elsewhere: set `PI_CODING_AGENT_DIR` or pass `--agent-dir` |
| No allowance data | omp only records `usage_history` for subscription providers it checks |
| Cost shows "unpriced" | omp did not record a cost for those requests |
| No speed figures | requests lacked duration or TTFT, or did not finish normally |
| `error store_newer` | the index was written by a newer TiboTattle; update instead of downgrading |
| `error port_in_use` | another process uses port 8787; try `serve --port 0` |

To start over, stop TiboTattle and delete its state directory (see
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
