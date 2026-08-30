# The self-hosting deploy harness

How `scripts/deploy/` works, and what it deliberately does not do.

**For the step-by-step deployment procedure, see [CLOUDFLARE_SETUP.md](../CLOUDFLARE_SETUP.md).**
This document is the reference behind it: the design decisions, and the reasons a few of them are
not negotiable.

## Where it sits

There are three deployment paths in this repo, and only one of them deploys a fork:

| Path | What it is | When |
| --- | --- | --- |
| `pnpm run-local` | the whole stack on local `workerd` | development |
| `scripts/release/` | a release manifest mirrored to R2 for Cloudflare's hosted deploy service | not available to forks |
| **`scripts/deploy/`** | deploys **this checkout** to one account you own | self-hosting |

## One topology, three resolutions

The binding topology — which worker binds which gatekeeper, under what name, through which
entrypoint — is stated once, in each package's committed `wrangler.jsonc`, and resolved three ways:

| Resolver | Resolves to |
| --- | --- |
| `scripts/run-dev-server.ts` | localhost |
| `scripts/release/manifest-lib.ts` | `$PLACEHOLDER` templates for the hosted deploy service |
| `scripts/deploy/deployment-config.ts` | concrete values for one account |

**A new binding on a deployable worker needs a decision in all three.** The release path fails
closed on an unrecognised config key (`HANDLED_CONFIG_KEYS`); this one passes unknown keys through,
so a binding that needs per-deployment resolution and does not get it will deploy quietly wrong.

## Structure

| File | |
| --- | --- |
| `deployment-config.ts` | pure: parsing, validation, config generation. No network, no spawning. |
| `deploy.ts` | orchestration: builds, provisioning, `wrangler deploy`, secrets. |
| `deployment-config.test.ts` | pins the whole topology under `node --test`, with no Cloudflare account. |

Keeping generation pure is what makes the topology testable at all — the tests assert the real
`wrangler.jsonc` files resolve to the right bindings, rather than asserting against a fixture that
can drift from them.

## Decisions worth knowing

**The `workers` map is the deployment.** Its key set decides what is deployed and what gets bound
into the backend and router. This is not a convenience: the router discovers gatekeepers by scanning
its own `GATEKEEPER_*` bindings at runtime, so "installed" genuinely means "bound", and a config
that says otherwise would be lying.

**Storage names are derived from worker names, and worker names are permanent.** The alternative —
deriving them from anything mutable, or letting them be independently configurable — makes it
possible to point a redeploy at empty storage without any error. An explicit entry in `resources` is
therefore *adopted, never created*: a typo that created a namespace would silently hand a worker
blank storage, so the harness fails instead.

**Storage is provisioned explicitly, not by wrangler.** Wrangler's automatic provisioning writes the
ids it invents back into the config file it read. These configs are regenerated every run, so that
write-back is discarded — and the next deploy would provision *new*, empty storage and bind to it.
`writeProdConfigs` fails closed on any unresolved binding rather than letting that reach wrangler.

**Secrets never enter a generated config.** Wrangler prints config values, and `wrangler.prod.jsonc`
is build output that a CI log or a support transcript easily carries. Secrets come from a gitignored
`.deploy.vars`, keyed per package so two gatekeepers cannot silently share a credential, and are
piped to `wrangler secret put` over stdin. `.deploy.vars` is also the *only* source: reading them
from the environment instead would put every deploy one exported variable away from uploading a
stale credential without saying so.

**Builds on the deploy path are uncached.** A cache hit is only as good as its fingerprint, and
every bug there has been a missing input. That is cheap to absorb on a build you can re-run and
expensive on a deploy you cannot.

**Deploys run in three tiers** — gatekeepers, then `workshop-backend`, then `router` — because each
tier's service bindings must name what the tier before it produced. Within a tier the workers are
independent but still deployed one at a time: interleaved output from a failing deploy is worse than
a slower run.

**Validation reports everything at once.** Filling in a deployment description is a single sitting,
and a validator that surfaces one field per run turns it into ten.

## What it does not do

- **No Cloudflare Access mode.** `CF_ACCESS_AUD` / `CF_ACCESS_ISS` and the
  `VITE_CF_ACCESS_MODE=true` frontend build are not wired up. Adding them is a `deployment.jsonc`
  block, two backend vars, and one env var on the frontend build in `preflightBuilds`.
- **No `gatekeeper-email`.** Email Routing needs a zone, so it is unavailable on a workers.dev
  origin — the same reason it is not installable on hosted instances.
- **No error Reporter or product analytics.** `ERROR_REPORTER`, `FRONTEND_ERROR_REPORTER`,
  `FRONTEND_ERROR_RATE_LIMITER` and `PRODUCT_ANALYTICS` are optional bindings that no-op when
  absent, and this harness leaves them absent.
- **No multi-environment support.** One `deployment.jsonc` describes one deployment; a second
  environment is a second file plus `--config`.
