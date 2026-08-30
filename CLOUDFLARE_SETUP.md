# Deploying Contentstack OS to Cloudflare

The complete runbook for deploying **this checkout** — fork changes included — to a Cloudflare
account. Written against the `Contentstack-Labs` deployment, so the concrete values below are real;
substitute your own for any other account.

For how the deploy harness itself works and what it deliberately does not cover, see
[docs/self-hosting.md](docs/self-hosting.md).

---

## Contents

1. [What gets deployed](#1-what-gets-deployed)
2. [Prerequisites](#2-prerequisites)
3. [Credentials](#3-credentials)
4. [Configure the deployment](#4-configure-the-deployment)
5. [Models](#5-models)
6. [Secrets](#6-secrets)
7. [OAuth apps](#7-oauth-apps)
8. [Deploy](#8-deploy)
9. [Verify](#9-verify)
10. [Day two](#10-day-two)
11. [Troubleshooting](#11-troubleshooting)
12. [Reference](#12-reference)

---

## 1. What gets deployed

Six Workers, in three tiers. The tiers are sequential because each tier's service bindings must
name what the tier before it produced.

| Tier | Package | Worker | Role |
| --- | --- | --- | --- |
| 1 | `gatekeeper-context` | `os-context` | Context Library — collections agents read as observations. Ambient. |
| 1 | `gatekeeper-scheduler` | `os-scheduler` | Scheduled Tasks — persistent workspace callbacks. Ambient. |
| 1 | `gatekeeper-github` | `os-github` | GitHub connector **and** GitHub sign-in |
| 1 | `gatekeeper-google` | `os-google` | Google connector **and** Google sign-in |
| 2 | `workshop-backend` | `os-workshop` | The kernel. Binds every gatekeeper over `GatekeeperVendor`. |
| 3 | `router` | `os` | The public origin. Serves the frontend, proxies `/api` and `/gatekeeper/<name>`. |

Plus four storage resources, provisioned automatically on first deploy:

| Kind | Name | Binding | Holds |
| --- | --- | --- | --- |
| KV | `os-workshop-blueprints` | `BLUEPRINTS` | blueprint metadata |
| KV | `os-workshop-avatars` | `AVATARS` | user avatars |
| KV | `os-context-context-collections` | `CONTEXT_COLLECTIONS` | public collection snapshots |
| R2 | `os-workshop-blueprint-content` | `BLUEPRINT_CONTENT` | blueprint code snapshots |

**Public origin:** `https://os.contentstacklabs.workers.dev`

Only the router is publicly reachable. The other five have no hostname and are reached over service
bindings — that is the security boundary, not an accident of configuration.

---

## 2. Prerequisites

### Tooling

| | |
| --- | --- |
| Node | 24.x (verified on v24.17.0) |
| pnpm | 11.17.0 — pinned by the `packageManager` field; `corepack enable` picks it up |

> This repo uses **pnpm**, never npm.

```sh
pnpm install
pnpm lint      # lint:check + types:scripts + types:check
pnpm test
```

### Account capabilities

All of these must be live on the target account. Missing ones fail late and confusingly, so check
before deploying rather than after.

| Capability | Needed for | `Contentstack-Labs` |
| --- | --- | --- |
| Workers **Paid** plan | Durable Objects, R2, Browser Rendering | ✅ |
| Workers Scripts | every worker | ✅ |
| **Worker Loader / Dynamic Workers** | the gadget sandbox — nothing works without it | ✅ |
| Durable Objects, SQLite-backed | workspaces, gadgets, gatekeeper accounts | ✅ |
| Workers KV | blueprint metadata, avatars, collections | ✅ |
| **R2** | blueprint code snapshots | ✅ (enable once in the dashboard) |
| Browser Rendering | gadget PDF/screenshot export | ✅ |
| Workers AI | `webFetch`'s document-to-Markdown conversion | ✅ |
| AI Gateway | only with `aiGateway.enabled` | ✅ available, unused |
| Artifacts | only for Git-backed context collections (closed beta) | not enabled — optional |

**R2 needs a one-time opt-in.** Dashboard → R2 → Enable. Until then every deploy fails with
`code 10042: Please enable R2 through the Cloudflare Dashboard`.

**Worker Loader is the one to verify deliberately** — it is the newest of these and is not on every
account. To check without deploying anything real, deploy a throwaway worker with just that binding
and no route, then delete it:

```sh
mkdir -p /tmp/probe && cd /tmp/probe
echo 'export default { fetch: () => new Response("ok") };' > probe.js
cat > wrangler.jsonc <<EOF
{ "name": "capability-probe", "main": "probe.js",
  "compatibility_date": "2026-02-02", "account_id": "$CLOUDFLARE_ACCOUNT_ID",
  "workers_dev": false, "worker_loaders": [{ "binding": "LOADER" }] }
EOF
pnpm exec wrangler deploy && pnpm exec wrangler delete --name capability-probe --force
```

`workers_dev: false` matters — the probe gets no public URL.

---

## 3. Credentials

Everything runs on a **scoped API token**, not `wrangler login`. That is what keeps a personal
default account out of the picture: the target account is pinned in three places at once — the
`account_id` written into every generated config, `CLOUDFLARE_ACCOUNT_ID` in every child process,
and the token's own scope.

Create it at **My Profile → API Tokens → Create Token → Create Custom Token**, scoped to this
account only:

| Permission | Level | Why |
| --- | --- | --- |
| Account · Workers Scripts | Edit | deploy the workers and their Durable Objects |
| Account · Workers KV Storage | Edit | provision and bind the KV namespaces |
| Account · Workers R2 Storage | Edit | provision and bind the R2 bucket |
| Account · Workers AI | Edit | the `WORKERS_AI` binding |
| Account · Browser Rendering | Edit | the `BROWSER` binding |
| Account · Account Settings | Read | account resolution |
| Account · AI Gateway | Read + Run | only with `aiGateway.enabled` |
| Zone · DNS | Edit | only with `route.customDomain` |

Put it in `.envrc` (gitignored) and source it before any wrangler or deploy command:

```sh
export CLOUDFLARE_ACCOUNT_ID=337ddfacdf6307d4c43c415fc70659a9
export CLOUDFLARE_API_TOKEN=...
```

```sh
source .envrc
pnpm exec wrangler whoami   # should print the target account, and only that account
```

> The API token is **not** a deployment input. It never goes in `deployment.jsonc` or
> `.deploy.vars` — it is the credential that performs the deployment.

---

## 4. Configure the deployment

```sh
cp deployment.example.jsonc deployment.jsonc
```

`deployment.jsonc` is gitignored; `deployment.example.jsonc` is the tracked template and documents
every field inline.

### The two fields to get right the first time

**`publicBaseUrl`** — read by two different consumers, and both are load-bearing:

- every gatekeeper's OAuth redirect URI is built from it, and
- it is the Context Library's default `sharingDomain`, a **data-isolation boundary**. Changing it
  later hides existing collections rather than breaking a link.

On workers.dev it is `https://<router worker>.<account subdomain>.workers.dev`. The subdomain is not
derivable from any file in this repo — read it from **Workers & Pages → your subdomain**, or:

```sh
source .envrc && curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain"
```

For `Contentstack-Labs` it is `contentstacklabs`.

**`workers`** — the key set *is* the deployment. `router` and `workshop-backend` are required; every
`gatekeeper-*` key present is deployed and bound into both. Adding a connector later is one more key
plus a redeploy, with no code change.

> **Worker names are permanent service identities**, and the KV/R2 resource names derive from them.
> Renaming a worker after the first deploy points it at fresh, empty storage. Choose once. Keep them
> clear of any worker already in the account — `Contentstack-Labs` has an unrelated
> `demandbase-pipeline`, hence the `os-` prefix. Only the router's name is user-facing.

### Sign-in

```jsonc
"admins": ["pradeep.mishra@contentstack.com"],
"auth": {
  "gatekeepers": ["google"],
  "disablePassword": true,
  "allowedEmailDomains": ["contentstack.com"],
  "sessionMaxAgeHours": 24
}
```

Each listed gatekeeper must also be in `workers` — a "Continue with …" button wired to a service
binding that does not exist is a broken sign-in page, so `pnpm deploy:check` rejects the mismatch.

The account key is always the **verified email**, so signing in with any allowlisted gatekeeper that
yields the same email lands on the same account. `admins` are matched the same way (usernames
instead, if you use password accounts).

Leave `disablePassword: false` for the first deploy so you can reach `/admin` before the OAuth apps
exist. Flip it once gatekeeper sign-in is verified. The backend ignores the flag while
`gatekeepers` is empty, specifically so a misconfiguration cannot lock everyone out.
`allowedEmailDomains` and `sessionMaxAgeHours` go in together with that flip, on the *second* deploy
— not the first — because `deploy:check` refuses a config that sets an allowlist while password auth
is still open.

> **Authentication config is deliberately not in `/admin`.** It becomes Worker vars, so changing it
> needs a redeploy — that is the point: a compromised admin session cannot change how people sign in.

### Validate

```sh
pnpm deploy:check
```

Validates the whole description, prints the plan (workers by tier, storage, expected secrets), and
writes the generated configs so you can read them. **No API calls.** Every problem is reported at
once rather than one per run.

---

## 5. Models

A deployment with no gateway means every user must paste their own API key before the agent does
anything. Two gateways are available, and they are peers — enable either, both, or neither. With
both, the model lists merge (Cloudflare first) and each built-in shows which gateway serves it.

### OpenRouter (what this deployment uses)

One platform key serves everyone. **There is no per-user fallback for OpenRouter** — a stored model
config's own token is never used for it — so `OPENROUTER_API_KEY` is what makes the agent work.

```jsonc
"openRouter": {
  "enabled": true,
  "models": ["anthropic/claude-sonnet-5", "..."],  // replaces the curated catalog
  "quickModel": "anthropic/claude-haiku-4.5",      // chat titles and other quick tasks
  "baseUrl": "https://openrouter.ai/api/v1"        // set only for a proxy
}
```

Only `enabled` and the key are required; the other three have code-side defaults.

**`deployment.jsonc` is the single source for the model catalog.** `run-dev-server.ts` seeds
`OPENROUTER_MODELS` / `_QUICK_MODEL` / `_BASE_URL` into local development from it, so the list is
stated once and dev matches production. Three sources, in falling precedence:

| Source | Use |
| --- | --- |
| shell environment | a one-off experiment |
| `.dev.vars` | a persistent local override |
| `deployment.jsonc` | the deployment's actual catalog |

`OPENROUTER_API_KEY` is deliberately **not** seeded — a deployment description holds no secrets — so
it stays in `.dev.vars` locally and `.deploy.vars` for the deploy.

> Per-turn cost for OpenRouter models is priced from pi's model catalog rather than read from a
> gateway log, so it is an estimate that can drift from OpenRouter's actual charges.

### Cloudflare AI Gateway (alternative)

```jsonc
"aiGateway": {
  "enabled": true,
  "name": "<gateway name>",
  "accountId": null,          // null = the same account the Workers live in
  "providers": ["cloudflare"] // "cloudflare" is Workers AI and needs no key of yours
}
```

Create the gateway first — `Contentstack-Labs` has none today:

```sh
source .envrc && curl -sS -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways" \
  -d '{"id":"os-ai","cache_ttl":0,"collect_logs":true,"rate_limiting_interval":0,"rate_limiting_limit":0,"rate_limiting_technique":"fixed"}'
```

The backend reaches the gateway over its `WORKERS_AI` binding, which is pre-authenticated inside
your own account, so **no API token is needed** — with two exceptions that both make
`CF_AI_GATEWAY_API_TOKEN` mandatory:

- the gateway lives in a **different account** (set `aiGateway.accountId`; the harness then emits
  `CF_AI_GATEWAY_USE_BINDING=false`, since binding requests cannot cross accounts), or
- the **`google`** provider, whose SDK adapter refuses the binding's fetch.

Anthropic/OpenAI/Google keys are stored **on the gateway** in the dashboard, not here.

---

## 6. Secrets

Secrets never enter a generated config. Wrangler prints config values, and those configs are build
output that a CI log or a support transcript easily carries. They live in `.deploy.vars`
(gitignored, `KEY=VALUE` per line) and are uploaded over stdin with `wrangler secret put`.

Keys are **qualified by package**, so two gatekeepers cannot silently share one credential. Backend
secrets are unqualified.

```
# packages/gatekeeper-github
GATEKEEPER_GITHUB_CLIENT_ID=...
GATEKEEPER_GITHUB_CLIENT_SECRET=...

# packages/gatekeeper-google
GATEKEEPER_GOOGLE_CLIENT_ID=...
GATEKEEPER_GOOGLE_CLIENT_SECRET=...

# workshop-backend
OPENROUTER_API_KEY=...
# CF_AI_GATEWAY_API_TOKEN=...     # only for a cross-account gateway, or the google provider
```

`pnpm deploy:check` prints the exact key list for your configuration. Upload with:

```sh
source .envrc && pnpm deploy:secrets
```

Secrets **survive redeploys**, so this is a one-off per credential rather than part of every deploy.
`pnpm deploy` also runs this step and reports anything still missing.

---

## 7. OAuth apps

Each connector needs an OAuth app registered with the third-party provider. The same app both
authenticates the user and connects the account's capabilities, so a gatekeeper listed in
`auth.gatekeepers` needs no second app.

Redirect URIs — `pnpm deploy` prints these at the end:

| Provider | Redirect URI |
| --- | --- |
| GitHub | `https://os.contentstacklabs.workers.dev/gatekeeper/github/oauth` |
| Google | `https://os.contentstacklabs.workers.dev/gatekeeper/google/oauth` |

> **Register the Google app as Internal** to the Contentstack workspace. `allowedEmailDomains`
> checks the domain of the address Google reports as verified, and a *consumer* Google account can
> be registered against a company address — including one whose workspace account has since been
> deleted. Internal is what makes `@contentstack.com` mean workspace membership rather than an
> address that merely ends in those characters, because Google then refuses outside accounts before
> the Workshop ever sees them.

Provider-specific steps (scopes, consent screen, org approval) are in each package's README:
[github](packages/gatekeeper-github/README.md) ·
[google](packages/gatekeeper-google/README.md) ·
[slack](packages/gatekeeper-slack/README.md) ·
[notion](packages/gatekeeper-notion/README.md) ·
[confluence](packages/gatekeeper-confluence/README.md) ·
[supabase](packages/gatekeeper-supabase/README.md) ·
[cloudflare](packages/gatekeeper-cloudflare/README.md)

Gatekeepers needing **no** OAuth app at all: `context`, `scheduler`, `homeassistant` (users supply
their own URL + token in-app), `mcp` and `mcp-portal` (MCP OAuth uses dynamic client registration).

You can register the apps before the first deploy — the origin is fixed by `publicBaseUrl`, not by
anything the deploy discovers.

---

## 8. Deploy

```sh
source .envrc
pnpm deploy
```

In order:

1. **Builds what wrangler cannot.** Each worker's own bundle is built by the `build.command` in its
   config, but three inputs are generated outside that: the backend's bundled format blueprints,
   every gatekeeper's UI, and the frontend bundle the router serves as static assets. All uncached —
   a deploy must not replay a stale artifact.
2. **Provisions storage**, idempotently, by deterministic name. Done explicitly rather than through
   wrangler's automatic provisioning, which writes the ids it invents back into a config this
   harness regenerates — so the *next* deploy would bind new, empty storage.
3. **Generates** each `wrangler.prod.jsonc` with the resolved ids.
4. **Deploys in three tiers.**
5. **Uploads secrets** from `.deploy.vars`, reporting any that are missing.
6. **Prints the OAuth redirect URIs.**

| Flag | Effect |
| --- | --- |
| `--check` | validate + generate only; no network calls |
| `--secrets` | upload secrets, deploy nothing |
| `--only <package>` | redeploy one worker |
| `--skip-build` | reuse the build outputs already on disk |
| `--config <path>` | use a different deployment description |

First run takes several minutes, most of it the frontend and gatekeeper UI builds.

---

## 9. Verify

- [ ] `https://os.contentstacklabs.workers.dev` serves the sign-in page.
- [ ] Sign in. With `auth.gatekeepers` set you get a "Continue with …" button per gatekeeper
      alongside the password form.
- [ ] `/admin` loads as one of `admins`. Set site name, logo and accent; confirm which connectors
      are offered.
- [ ] A model is selectable and a chat gets a reply. **This is the real test of
      `OPENROUTER_API_KEY`** — a missing key surfaces as "OpenRouter is not configured for this
      deployment".
- [ ] Ask the agent to build something ("make a tic tac toe game"). **This is the real test of the
      Worker Loader binding**, since gadget code runs in a Dynamic Worker.
- [ ] `/gatekeepers/context` and `/gatekeepers/scheduler` load — both are ambient, so they should be
      present with no user action.
- [ ] Connect a GitHub repo and a Google doc, to exercise each OAuth flow end to end.
- [ ] Export a gadget to PDF, to exercise the `BROWSER` binding.
- [ ] `pnpm exec wrangler tail os-workshop` shows structured logs with no startup errors.
- [ ] Sign in with a non-`@contentstack.com` Google account: the popup reports
      "Only @contentstack.com accounts can sign in to this deployment." and no account is created.
- [ ] The password form is gone from both the login and signup pages.

---

## 10. Day two

**Redeploying** is `pnpm deploy` again. Storage is adopted by name, secrets persist, and each
worker's Durable Object migration history is replayed from its committed `wrangler.jsonc`, so state
survives.

**Adding a connector** is one more `workers` key plus `pnpm deploy` — the router discovers
gatekeepers by scanning its own `GATEKEEPER_*` bindings, so no routing code changes. Then register
its OAuth app and add its two `.deploy.vars` keys.

**Adding the MCP portal:** add `"gatekeeper-mcp-portal": "os-mcp-portal"` to `workers` and set
`mcpPortal.url` to the portal's Streamable HTTP endpoint. Users never type a URL — that field is the
entire configuration of the connector. Leave `trustAnnotations` off unless every upstream server
behind the portal is itself trusted: a portal is an aggregator, and those annotations are written by
whichever server it proxies, not by you.

### What needs a redeploy, and what does not

| Change | Redeploy? |
| --- | --- |
| Branding, banners, agent instructions, which connectors are offered | **No** — `/admin`, stored as `AdminConfig` |
| Sign-in method, admins, model gateways, worker set, routing | Yes — Worker vars |
| A secret's value | No — `pnpm deploy:secrets` alone |
| Code changes | Yes |

### Moving to a custom domain

Set `route` to `{ "customDomain": "os.example.com" }` and `publicBaseUrl` to
`https://os.example.com` — they must agree, and `deploy:check` rejects a mismatch. The zone must be
active in the same account; wrangler creates the DNS record and certificate. Then **re-register
every OAuth redirect URI** against the new origin, and set `context.sharingDomain` to the *old*
origin to keep existing collections visible.

---

## 11. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `code 10042: Please enable R2` | R2 not enabled. Dashboard → R2 → Enable. |
| `worker_loaders` binding rejected | Worker Loader not available on the account. Probe it (§2); nothing works without it. |
| Deploy hits the wrong account | `.envrc` not sourced, or the token is scoped elsewhere. `wrangler whoami` before deploying. |
| `A request to the Cloudflare API … failed` on `kv namespace list` | Token lacks Workers KV Storage: Edit. |
| Sign-in button 404s | The gatekeeper is in `auth.gatekeepers` but its worker was not deployed, or the redirect URI registered with the provider does not match `publicBaseUrl`. |
| OAuth returns `redirect_uri_mismatch` | The provider's registered URI must be exactly `<publicBaseUrl>/gatekeeper/<name>/oauth` — no trailing slash. |
| "OpenRouter is not configured for this deployment" | `OPENROUTER_API_KEY` never uploaded. `pnpm deploy:secrets`. |
| Context collections vanished after a change | `sharingDomain` moved. Set `context.sharingDomain` explicitly to the previous value. |
| Blueprints/avatars empty after a redeploy | A worker was renamed, so the derived storage names changed. Pin the old ids in `resources` — an explicit name is adopted, never created. |
| Gatekeeper UI is stale | The UI bundle is generated outside wrangler. Redeploy without `--skip-build`. |
| Deploy is slow every time | Expected: the deploy path is uncached on purpose. Use `--skip-build` when only config changed. |

Logs: `pnpm exec wrangler tail <worker name>`.

---

## 12. Reference

### Commands

| | |
| --- | --- |
| `pnpm run-local` | whole stack on local workerd, `http://localhost:8787` |
| `pnpm dev-server` + `pnpm dev-client` | development, `http://localhost:3000` |
| `pnpm lint` | `lint:check` + `types:scripts` + `types:check` — what CI enforces |
| `pnpm test` | unit tests |
| `pnpm deploy:check` | validate + generate, no network |
| `pnpm deploy` | full deploy |
| `pnpm deploy:secrets` | upload secrets only |

### Files

| | |
| --- | --- |
| `.envrc` | Cloudflare credentials. Gitignored. Never a deployment input. |
| `deployment.jsonc` | this deployment's description. Gitignored. |
| `deployment.example.jsonc` | tracked template, every field documented |
| `.deploy.vars` | secrets uploaded to workers. Gitignored. |
| `.dev.vars` | local development env. Gitignored. Never read by the deploy. |
| `packages/*/wrangler.prod.jsonc` | generated per deploy. Gitignored — build output. |
| `.env.example` | reference for every environment variable the workers read |

### Where the deployment's settings end up

| `deployment.jsonc` | Becomes |
| --- | --- |
| `accountId` | `account_id` in every generated config |
| `publicBaseUrl` | backend `PUBLIC_BASE_URL`; each gatekeeper's `BASE_URL`; Context `sharingDomain` prop |
| `route` | router `workers_dev` or a `custom_domain` route |
| `admins` | backend `ADMINS` (a JSON array binding) |
| `auth.gatekeepers` | backend `AUTH_GATEKEEPERS` |
| `auth.disablePassword` | backend `DISABLE_PASSWORD_AUTH` |
| `auth.allowedEmailDomains` | backend `ALLOWED_EMAIL_DOMAINS` |
| `auth.sessionMaxAgeHours` | backend `SESSION_MAX_AGE_HOURS` |
| `workers` | worker names, and the `GATEKEEPER_*` service bindings on backend and router |
| `aiGateway.*` | backend `CF_AI_GATEWAY*` |
| `openRouter.*` | backend `OPENROUTER_MODELS` / `_QUICK_MODEL` / `_BASE_URL` |
| `mcpPortal.*` | `MCP_PORTAL_URL` / `_NAME` / `_AUTH` / `_TRUST_ANNOTATIONS` on the portal worker |
| `context.artifacts` | the `ARTIFACTS` binding on `gatekeeper-context` |
| `resources` | KV namespace ids and the R2 bucket name |
| `observability` | the `observability` block on every worker |

### Related docs

[docs/self-hosting.md](docs/self-hosting.md) — how the harness works ·
[docs/public-server.md](docs/public-server.md) — running as a public multi-user service ·
[docs/oauth-signin.md](docs/oauth-signin.md) — sign-in internals ·
[docs/ai-gateway-billing.md](docs/ai-gateway-billing.md) — free-tier limits and top-up ·
[.env.example](.env.example) — every environment variable ·
[AGENTS.md](AGENTS.md) — architecture
