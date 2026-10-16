# Decision: TiboTattle becomes a local-first monitor for omp

- **Date**: 2026-10-16
- **Status**: accepted
- **Applies from**: 0.2.0

## Context

TiboTattle 0.1.x monitored Codex usage. Around a local analysis core it had
grown an optional community-sharing pipeline, a hosted Cloudflare Worker with
D1/R2 storage, GCP services, accountless and account-based contribution
consent, a native macOS app and an Electron app with signed installers and
updater feeds, plus the release, attestation and evidence tooling needed to
operate all of that responsibly.

The maintainer now works with the [oh-my-pi](https://github.com/can1357/oh-my-pi)
(`omp`) coding agent by Can Bölük, a fork of Mario Zechner's pi. omp already
records, locally, most of what TiboTattle used to reconstruct: per-message
token usage, cost, duration, time to first token, service tier and credential,
and subscription limit snapshots in its `usage_history` table. What was missing
was a small, private place to see that data together.

## Decision

Rewrite TiboTattle as a local-first, offline monitor for omp:

- Read omp's session logs and `usage_history` read-only, keep a content-free
  SQLite index, and serve a dashboard on `127.0.0.1`.
- Use only Node.js 22.13+ built-ins at runtime. Keep Electron as the single,
  optional dev dependency for a tray app.
- Ship from source. There are no installers, signing, updater or published
  release artifacts.

Removed from the working tree:

- Codex ingestion, provider normalization and the Codex price registry.
- Community sharing, contribution projection, prepared sets, consent and
  opt-out state, pseudonymous identity continuity.
- The hosted Worker (D1/R2, auth, deployment), GCP services and the public
  website.
- Accounts and sign-in, the native macOS app, native Windows helpers.
- Updater feeds, signing, notarization, attestations, release and R7 receipt
  tooling, and the plans, audits, receipts and runbooks that supported them.

The full history of the Codex edition, including its source, release notes,
decisions and evidence, remains in git history.

## Consequences

- The privacy story is simpler and stronger: nothing leaves the machine, so
  there is no consent state, no erasure workflow and no hosted data to manage.
- Allowance is only as good as omp's snapshots: it appears only for
  subscription providers whose usage omp fetches, and stale snapshots are shown
  as stale rather than extrapolated.
- Cost is omp's own recorded estimate, not provider billing. TiboTattle no
  longer maintains a price registry; unrecorded cost is shown as unpriced.
- The 0.1.x index and settings are not migrated. The new index is rebuilt from
  omp's files on first run.
- Existing 0.1.x installations no longer receive updates. Users of the hosted
  service or the Codex edition must rely on the last 0.1.x release.
- Contributors need only Node.js to run and test the project.

## Alternatives considered

- **Add omp as another provider beside Codex.** Rejected: it would keep the
  hosted and sharing surface, and its release obligations, alive for a product
  that no longer needs them.
- **Fork into a new repository.** Rejected: keeping one repository preserves
  the history and the name, and git history keeps the retired edition
  auditable.
