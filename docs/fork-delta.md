# Fork delta

Every way this fork deliberately differs from [`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os), and what enforces it.

This file exists because a fork's real risk is not a merge conflict — git stops and asks about those. The risk is a file upstream changed and the fork did not: it auto-merges cleanly and silently reverts fork intent, with nothing failing. The 2026-08-20 merge contained four of those. Every one was found by hand, and one was found by accident.

So each row below is backed by an assertion in `scripts/fork-intent.test.ts`, which runs under `pnpm test` and therefore in CI on every pull request. The ids are stable and are never reused.

**The rule is not that the fork always wins.** It is that the fork never loses by accident. When upstream genuinely needs to displace something here, cede it deliberately — see the cede protocol in [`upstream-merge-runbook.md`](./upstream-merge-runbook.md).

## Held

Intents currently enforced. Adding fork behaviour worth defending means adding a row here *and* an assertion with the same id.

| Id | Intent | Lives in |
| --- | --- | --- |
| **F1** | **OpenRouter as a peer gateway to the Cloudflare AI Gateway** | |
| F1.1 | The `ModelGateway` registry abstracts over gateways, so a third stays additive | `workshop-backend/src/ai-gateway.ts` |
| F1.2 | The Cloudflare gateway is one implementation (`CloudflareModelGateway`), not the only one | `workshop-backend/src/ai-gateway.ts` |
| F1.3 | `openrouter` is a first-class `AiModelProvider` | `workshop-shared/src/api.ts` |
| F1.4 | `AiGatewayId` and the `gateways` routing list are on the RPC API | `workshop-shared/src/api.ts` |
| F1.5 | `listModels()` returns gateway-tagged `AiModelInfo`, never a bare `AiChatAuthorInfo` | `workshop-shared/src/api.ts` |
| F1.6 | The curated OpenRouter catalog ships with the deployment | `workshop-shared/src/api.ts` |
| F1.7 | A user with no gateway still gets quick tasks, falling back to their own model | `workshop-backend/src/user.ts` |
| F1.8 | The dev server passes the OpenRouter credentials through to the backend | `scripts/run-dev-server.ts`, `.env.example` |
| F1.9 | Model pickers show and search on the serving gateway | `workshop-frontend/src/modelListDisplay.ts` and siblings |
| **F2** | **Contentstack identity on the Venus palette** | |
| F2.1 | The product is named Contentstack OS, in constants *and* in prose | `workshop-shared/src/api.ts`, `README.md` |
| F2.2 | Design tokens are a shared package, not copied per app | `packages/design-tokens/` |
| F2.3 | The default accent is Venus purple, not Cloudflare orange | `workshop-frontend/src/theme.ts` |
| F2.4 | The Contentstack mark is what the shell renders | `workshop-frontend/src/components/ContentstackMark.tsx` |
| F2.5 | Gatekeeper connect pages take their palette from `design-tokens` | `mcp-shared/src/html.ts` |
| F2.6 | The legacy-palette ratchet still guards against Cloudflare colours | `scripts/legacy-palette.test.ts` |
| **F3** | **Type scale and contrast remediation** | |
| F3.1 | The `text-ui-*` scale is what sizes UI text (floor: 40 files) | `workshop-frontend/src/` |
| F3.2 | The sizing and contrast ratchets still run | `scripts/design-tokens.test.ts`, `workshop-frontend/src/designTokens.test.ts` |
| F3.3 | Inter Variable is actually shipped, not merely named | `workshop-frontend/public/fonts/` |
| F3.4 | The accent variable list stays derived, so a test cannot drift from it | `workshop-shared/src/theme.ts` |
| **F4** | **Context Library CI ingestion** | |
| F4.1 | The ingestion pipeline modules exist | `gatekeeper-context/src/ingest-*.ts` and siblings |
| F4.2 | The worker serves ingestion over HTTP as a `WorkerEntrypoint` (DOs via `ctx.exports`) | `gatekeeper-context/src/index.ts` |
| F4.3 | Ingestion is rate limited globally as well as per collection | `gatekeeper-context/src/index.ts` |
| F4.4 | Ingestion token types are on the gatekeeper API | `gatekeeper-context/src/context-types.ts` |
| F4.5 | `ratelimits` bindings survive into the release manifest | `scripts/release/manifest-lib.ts` |
| **F5** | **Explicit workspace creation** | |
| F5.1 | `createWorkspace` is on the RPC API and implemented | `workshop-shared/src/api.ts`, `workshop-backend/src/server.ts` |
| F5.2 | All creation paths share one register-and-open, with rollback | `workshop-backend/src/server.ts` |
| F5.3 | A user-chosen title is latched against auto-naming | `workshop-backend/src/overseer.ts`, `workspace-title.ts` |
| F5.4 | Analytics can tell a named workspace from a speculative one | `workshop-backend/src/analytics.ts` |
| F5.5 | The default workspace title is a shared constant | `workshop-shared/src/api.ts` |
| F5.6 | The create-workspace dialog and its bus exist | `workshop-frontend/src/components/` |
| **F6** | **Chat timeline rail and composer** | |
| F6.1 | The timeline rail is derived by its own module, not inline | `workshop-frontend/src/chatRail.ts` |
| F6.2 | The composer surface is flat, with no top border | `workshop-frontend/src/ChatInterface.tsx` |
| **F7** | **A self-hosting deploy harness for this checkout** | |
| F7.1 | The harness, its tracked template and both guides exist | `scripts/deploy/`, `deployment.example.jsonc`, `CLOUDFLARE_SETUP.md`, `docs/self-hosting.md` |
| F7.2 | Topology is derived from the committed wrangler configs, not restated | `scripts/deploy/deployment-config.ts` |
| F7.3 | A deployment is reachable from the root scripts | `package.json` |
| F7.4 | One deployment's own description and secrets stay untracked | `.gitignore` |
| F7.5 | Local dev inherits the deployment's model catalog rather than restating it | `scripts/deploy/deployment-config.ts`, `scripts/run-dev-server.ts` |
| **F8** | **A deployment-scoped sign-in restriction** | |
| F8.1 | Every email-keyed entry point enforces the domain allowlist | `workshop-backend/src/auth/login-flow.ts`, `workshop-backend/src/server.ts` |
| F8.2 | The allowlist is env-driven, never part of `AdminConfig` | `workshop-backend/src/auth/config.ts` |
| F8.3 | A configured allowlist disables password auth, failing closed rather than open | `workshop-backend/src/auth/config.ts` |
| F8.4 | Session tokens expire against a configurable maximum age | `workshop-backend/src/user.ts` |
| F8.5 | The deploy harness rejects a config whose admins cannot sign in | `scripts/deploy/deployment-config.ts` |

## Ceded

Fork intent deliberately given up, so the trade is a matter of record rather than a mystery in the history. Ids are retired, never reused.

| Id | What the fork wanted | Ceded to | Why | Regression risk |
| --- | --- | --- | --- | --- |
| F0.1 | `AGENTS.md` normalised to `-` bullets (chore `74d5464`) | `dd2b015` | Upstream rewrote the file with substantively newer content — the `.ts` script migration, Vite+, GitHub Actions. Keeping the fork's formatting meant keeping stale instructions. | None. Formatting only; no behaviour. |
| F3.5 | `ConnectionLostBanner` restyled onto `text-ui-md` (part of the type remediation) | `dd2b015` | Upstream deleted the component as unreferenced. It was already dead code in the fork — defined, never rendered. | None. `GadgetEditor`'s `ReconnectingChip` is the live reconnect affordance and does carry `text-ui-xs`. |
| F6.3 | Prompt card elevation varying by the surface it sits on (`docked` lifted, `canvas` flat) | `9f97b7e` (local) | Not displaced by upstream — a deliberate design change here. The composer went fully flat, which is what F6.2 already asserts; an elevation that varied by surface contradicted it, so the two intents could not both stand. The `surface` prop, its two `themed-prompt-card-*-shadow` rules, and the branch that chose between them are all gone. | Low, but not none. Those rules carried the card's only `:focus-within` treatment, and the composer textarea declares no focus style of its own — it paints transparent text over a mirror. Focusing the composer now changes nothing but the caret. Defensible for a text input, and no automated check covers it. |

## Deliberately *not* tracked here

- **Formatting.** The fork ran a prettier-style pass over `workshop-shared/src/api.ts` and `workshop-frontend/src/ChatInterface.tsx`. That produced roughly 60 of the 61 conflict hunks in those two files during the 2026-08-20 merge, none of them about behaviour. This is a cost, not an intent, and is not defended — see the runbook's note on reducing conflict volume.
- **Upstream code migrated onto fork conventions.** When upstream adds code that the fork's own ratchets reject (a bare `text-xs`, an export without JSDoc), migrating it is ordinary conflict resolution. The ratchets already enforce it; it needs no row here.
