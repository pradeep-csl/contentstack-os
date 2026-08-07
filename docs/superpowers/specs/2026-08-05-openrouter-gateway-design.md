# OpenRouter as a peer AI gateway

Date: 2026-08-05

## Goal

Support OpenRouter as a first-class, deployment-managed model source alongside Cloudflare AI
Gateway. A deployment may enable either, both, or neither. When OpenRouter is enabled its models
appear as built-ins everywhere models are listed or selected — onboarding, the providers page, the
Add-Model dialog, the chat picker, blueprint bindings — with no user-supplied credentials, exactly
as Cloudflare-gateway models do today.

## Non-goals

- **Any form of BYOK for OpenRouter.** This is an internal, company-funded deployment: the company
  holds both the Cloudflare and the OpenRouter key, and everyone in the company shares them. There is
  no OpenRouter OAuth, no `gatekeeper-openrouter`, no credit-balance gating, and no path for a user
  to supply their own OpenRouter key. Every OpenRouter request uses the platform key.
- **Touching the existing BYOK paths.** The per-provider user-key path (`getModelDirect` for
  Anthropic/OpenAI/Google/Ollama) and the Cloudflare unified-billing path stay exactly as they are —
  this work neither extends nor removes them. Removing them, if that's wanted, is separate work.
- **Fixing BYOK-in-gateway-mode.** Today, when a platform gateway is configured, `getModel()`
  ignores a stored model config's `apiToken` and routes through the gateway
  (`ai-models.ts` `getModel`, "The config's apiToken/apiUrl are ignored in that mode"), even though
  the providers page invites users to "add custom models with your own API tokens". That
  inconsistency predates this work and is left as-is. With OpenRouter this stops being a wart and
  becomes the intended behavior: gateway-served, platform-paid.
- **Routing OpenRouter through Cloudflare AI Gateway's `/openrouter` passthrough.** OpenRouter is
  reached directly. Chaining the two gateways buys nothing here and would confuse cost attribution.
- **Dynamic catalog browsing** of OpenRouter's 300+ models. Built-ins are a curated list plus an env
  override; anything else is reachable through "Other OpenRouter…".

## Concepts

The codebase currently conflates two ideas under "provider". This design separates them:

- **Provider** (`AiModelProvider`) — the vendor/API dialect of a model: `anthropic`, `openai`,
  `google`, `cloudflare`, `ollama`, and now `openrouter`. Determines which pi API implementation
  speaks to it.
- **Gateway** — a deployment-managed source of built-in models with platform-held credentials:
  `cloudflare` (existing) and `openrouter` (new). Determines who pays and how a request is routed.

The mapping from provider to gateway is a function, not a stored field: `openrouter` models are
served by the OpenRouter gateway, everything else by the Cloudflare gateway. Nothing new is
persisted on `AiModelConfig`, so existing stored models keep working untouched.

## Backend design

### 1. Gateway registry (`ai-gateway.ts`)

Extract an interface from the existing class and add a second implementation:

```ts
export type AiGatewayId = "cloudflare" | "openrouter";

export interface ModelGateway {
  readonly id: AiGatewayId;
  readonly label: string;               // "Cloudflare AI Gateway" | "OpenRouter"
  readonly providers: Set<AiModelProvider>;
  getModelList(): AiModelInfo[];        // built-ins, each tagged with this gateway's id
  resolveModel(modelId: string): UserAiModelRecord | undefined;
  getQuickModelConfig(): AiModelConfig | undefined;
}

export function getActiveGateways(env: Cloudflare.Env): ModelGateway[];
export function getGatewayForProvider(env, provider: AiModelProvider): ModelGateway | undefined;
export function resolveGatewayModel(env, modelId: string): UserAiModelRecord | undefined;
```

`AiGatewayConfig` becomes `CloudflareModelGateway implements ModelGateway` with its current logic
intact (`CF_AI_GATEWAY*` parsing, `providers` from `CF_AI_GATEWAY_PROVIDERS`, Workers AI quick
model). `OpenRouterModelGateway` is new: enabled by `OPENROUTER_API_KEY`, `providers` is the fixed
set `{"openrouter"}`, built-ins from `OPENROUTER_MODELS` or the curated default.

`getActiveGateways()` returns Cloudflare first, then OpenRouter — a deterministic order that makes
the merged list stable. Callers in `user.ts` and `overseer.ts` talk to the registry facade, never to
a concrete gateway, so a third gateway later is additive.

**Quick model.** Each gateway supplies its own; the registry returns the first active gateway's, so
Cloudflare's cheap Workers AI model still wins when both are on and an OpenRouter-only deployment
gets a working quick model instead of silently skipping title generation. Default
`OPENROUTER_QUICK_MODEL=anthropic/claude-haiku-4.5`.

### 2. Model routing (`ai-models.ts`)

- `AiModelProvider` gains `"openrouter"`; `catalogModel()` gains
  `case "openrouter": return OPENROUTER_MODELS[modelId]` (imported per-provider from
  `@earendil-works/pi-ai/providers/openrouter.models`, never `providers/all`).
- `getModelDirect()` gains an `openrouter` case: `api: "openai-completions"`,
  `provider: "openrouter"`, `baseUrl: config.apiUrl ?? "https://openrouter.ai/api/v1"`,
  `compat: catalog?.compat`. The key is always the platform's `OPENROUTER_API_KEY`; a stored
  config's `apiToken` is never consulted for this provider (no BYOK — see Non-goals). If an
  OpenRouter model is somehow selected while `OPENROUTER_API_KEY` is unset — a stored model left
  behind after the key was removed — throw a clear "OpenRouter is not configured for this
  deployment" rather than issuing a keyless request that returns an opaque 401.
- **`provider: "openrouter"` on the descriptor is load-bearing.** pi's `detectCompat()` derives the
  entire OpenRouter dialect from `model.provider` / `model.baseUrl`: openrouter-format reasoning,
  openrouter session affinity, and `cacheControlFormat: "anthropic"` for `anthropic/*` ids — the
  last of which is what drives `applyAnthropicCacheControl()` and therefore prompt caching over the
  completions dialect. Get the provider string wrong and all of it silently reverts to plain-OpenAI
  behavior: no cache reads, reasoning off, invisible in behavior and large in cost on long agent
  loops. Catalog `compat` is passed as well and merges over those detected defaults per key
  (`getCompat()`), adding model-specific refinements. Covered by a `cache_control` test.
- `getModel()` dispatch gains one branch before the existing Cloudflare-gateway check: when
  `config.provider === "openrouter"` and an OpenRouter gateway is active, build the handle with the
  platform key. No `aiGatewayLogRoute` is set (there is no AI Gateway log), which routes cost
  accounting down the `estimatedCost` path described below.
- `gatewayNativeModel()` is untouched — it stays Cloudflare-specific.
- **Attribution headers.** OpenRouter requests send `HTTP-Referer: PUBLIC_BASE_URL` and
  `X-Title: <site name>` so usage is identifiable in the OpenRouter dashboard. The `cf-aig-metadata`
  header is Cloudflare-only and is not sent.
- **Reasoning.** `makeHandle()`'s `apiExtras` currently branches on `anthropic-messages` and
  `openai-responses` only, so an `openai-completions` model gets no thinking config. Add a branch for
  `provider === "openrouter"` passing `reasoningEffort: "medium"` (the option name in pi's
  `openai-completions` API type — the same knob the Responses branch uses). This is not merely a
  missing default: pi's openrouter branch, given no effort, emits `reasoning: {effort: "none"}` —
  thinking explicitly **off**. Without the branch, OpenRouter-served Claude/GPT models silently run
  without reasoning, a capability regression versus the same model via the Cloudflare gateway.

### 3. Cost accounting — no new code path

pi computes `usage.cost` from the model catalog's per-token rates
(`pi-ai/dist/models.js`: `usage.cost.input = (rates.input / 1e6) * usage.input`), and
`Overseer.addChatMessages()` already falls back to that `estimatedCost` whenever no AI Gateway log
id is present. Since pi's OpenRouter catalog carries real prices, per-turn cost display works with
**zero** changes to the cost pipeline. No `GET /api/v1/generation` call, no retry logic, no new
`AiGatewayLogRoute` variant.

Accepted limitation: catalog prices are a snapshot and can drift from what OpenRouter actually
charges (provider routing variance, `:floor`/`:nitro` variants). The figure is already labelled
best-effort UI accounting and is explicitly not a billing source of truth. Refreshing prices means
bumping pi-ai. Documented, not worked around.

### 4. Interaction with the Cloudflare limits flow

This deployment is an internal, company-funded app: both the Cloudflare and OpenRouter keys belong to
the company, every employee uses the same keys, and per-user BYOK is not part of the product. So
`ENABLE_CLOUDFLARE_LIMITS` is expected to stay unset, in which case `checkUsageAndBalance()`
short-circuits to `unlimitedResult()`, no `userGateway` is ever resolved, and none of the
free-tier/BYOK machinery runs. No changes to the usage checker, `limits.ts`, or the block messages
are in scope.

One guard is still required, because the code path exists and would fail hard if limits were ever
switched on: `checkUsageAndBalance()` returns `shouldUseByok: true` for a connected+funded user, and
the overseer then passes `userGateway` into `getModel()` for **every** model, where
`getModelViaUserGateway()` *throws* for providers Cloudflare unified billing cannot serve. Make that
non-fatal: in `getModel()`, when `options.userGateway` is set but the config's provider is not
servable through the user's gateway, ignore it and route through the platform gateway instead of
throwing. Three lines, and it removes a latent hard failure.

Consequence, documented deliberately: if the company later enables `ENABLE_CLOUDFLARE_LIMITS`,
OpenRouter turns are platform-paid and do **not** consume the daily counter (the funded-user branch
returns before the counter is touched). That is acceptable while the company pays for both keys
anyway; making the counter model-aware is the follow-up if per-user metering ever matters.

**Paths that never reach this check (pre-existing, unchanged).** Quick-model work — thread titles,
gadget titles, compaction summaries (`overseer.ts` `getModel` calls outside the turn path) — and
gadget-initiated `LanguageModelBinding.run()` calls do not consult `checkUsageAndBalance` at all.
OpenRouter usage from those paths is platform-paid and unmetered, exactly as Workers AI is today.
Noted so it isn't mistaken for a regression introduced here; metering them is out of scope (the
existing `TODO: Account LLM costs back to the calling gadget` tracks it).

### 5. Built-in model list

`SUGGESTED_MODELS` gains an `openrouter` section. Values are taken from pi's catalog so compaction
budgets are correct (`agent-compaction.ts` reads `contextWindow` from `SUGGESTED_MODELS`, not from
pi):

| id | context | note |
|---|---|---|
| `anthropic/claude-sonnet-5` | 1,000,000 | default pick |
| `anthropic/claude-opus-5` | 1,000,000 | |
| `openai/gpt-5.6-sol` | 1,050,000 | `outputLimit: 128000` |
| `google/gemini-3.6-flash` | 1,048,576 | |
| `moonshotai/kimi-k2.7-code` | 262,144 | cheap coding model |
| `z-ai/glm-4.7` | 202,752 | cheap coding model |

`OPENROUTER_MODELS=id1,id2` overrides the list. Ids outside `SUGGESTED_MODELS` still work — pi's
catalog supplies cost and window to `ai-models.ts`, and compaction falls back to its 128k default,
which is conservative (a model with a larger real window simply compacts earlier than necessary).

### 6. Types (`workshop-shared/src/api.ts`)

```ts
export type AiModelProvider = "openai" | "anthropic" | "google" | "cloudflare" | "ollama" | "openrouter";
export type AiGatewayId = "cloudflare" | "openrouter";

// listModels() only — NOT the type embedded in chat messages.
export type AiModelInfo = AiChatAuthorInfo & { gateway?: AiGatewayId };

export type AiGatewayInfo =
  | { enabled: true; enabledProviders: AiModelProvider[]; gateways: { id: AiGatewayId; label: string }[] }
  | { enabled: false };
```

`AiChatAuthorInfo` is embedded in every chat message and is deliberately lightweight, so the gateway
tag goes on a list-only extension type instead. `listModels()` returns `AiModelInfo[]`; because that
is a superset of `AiChatAuthorInfo`, all six existing call sites keep compiling. `AiGatewayInfo`
grows additively — `enabledProviders` stays the union across active gateways, so
`AddModelModal`'s existing provider filter needs no change.

**Hard constraint: only `getModelList()` may carry the tag.** `resolveModel()`'s profile flows into
`getUserMeta().aiModel.profile` and becomes the author stamped onto every persisted chat message, so
it must keep returning a bare `AiChatAuthorInfo`. Tagging it would write the gateway id into the
chat log for every message — precisely what the `AiChatAuthorInfo` comment forbids. A test asserts
`resolveModel()` profiles have no extra fields.

`ATTACHMENT_SUPPORT_BY_PROVIDER` gains `openrouter: isTextOrImageMime`. PDFs are excluded: bridging
is keyed on the model's API and `openai-completions` has no native document input.

## UI design

Chosen through mockups (see `.superpowers/brainstorm/`): the gateway name occupies the **existing**
pill slot, and search appears only when the list is genuinely long.

**Row lists** (`providers.tsx`, `OnboardingWizard.tsx`) — the pill that reads `built-in` today reads
`Cloudflare` or `OpenRouter` instead. (`Cloudflare`, not `Workers AI`: that gateway also serves
Anthropic, OpenAI, and Google models, so naming it after one provider would mislabel most of its
rows.) Same slot, same styling, strictly more information; a row with
no pill is a model added with a user-supplied key (still possible for the non-OpenRouter providers).
`providers.tsx`'s client-side `isBuiltIn()` heuristic
(re-deriving built-in-ness by scanning `SUGGESTED_MODELS`) is **deleted** — the backend now states
it via `AiModelInfo.gateway`, a net simplification.

**Add-Model dialog** — `Select` → Kumo `Combobox` (`Root`/`TriggerInput`/`Input`/`List`/`Group`/
`GroupLabel`/`Item`/`Empty`), a like-for-like swap that keeps the provider groups and adds
type-to-filter, keyboard nav, and an empty state. OpenRouter needs no layout work: it arrives as one
more group from the existing `buildOptions()` loop, plus two `Record` entries (`PROVIDER_LABELS:
'OpenRouter'`, `API_TOKEN_PLACEHOLDERS: 'sk-or-v1-…'`). Justification: with both gateways on there
are ~14 built-ins and ~20 dropdown options.

Note on credentials: the dialog's `showCredentials` is `!gatewayMode`, so with a gateway configured
no token field is shown at all — it already submits `apiToken: ''` and offers "Other <provider>…".
For OpenRouter that is exactly the behavior we want: a user can pin any of OpenRouter's 300+ model
ids and have it served by the platform key, with no credential prompt. No new validation branch is
needed; `API_TOKEN_PLACEHOLDERS` gains an OpenRouter entry only to satisfy the `Record` type.

**Onboarding step** — layout unchanged (same card, same rows, same empty state). Adds the pill, plus
a search input rendered **only when the list exceeds 8 models**, mirroring `providers.tsx`, which
already hides its search when there is nothing to search. Small self-hosted deployments keep today's
one-tap step.

**Gateway notice** — the providers page notice is generalized from "AI Gateway mode" to name the
active gateways: "Built-in models are managed by your deployment (Cloudflare AI Gateway,
OpenRouter)." Driven by `AiGatewayInfo.gateways`.

**Blueprint auto-binding needs a tie-break.** This affects only blueprints, never a user's explicit
pick: choosing a model from any list sends its exact id, and the gateway pill is what distinguishes
two same-named rows on screen. `findSuggestedModelId()` resolves a blueprint's
suggested `{provider, modelName}` by matching `model.id === modelName` *or*
`model.id === ${provider}/${modelName}`. With both gateways active, a suggestion of
`{anthropic, claude-sonnet-5}` matches **two** models — `claude-sonnet-5` (Cloudflare) and
`anthropic/claude-sonnet-5` (OpenRouter) — so `exactMatches.length === 1` fails, the
`providerScopedMatches` fallback also finds two, and the function returns `null`. A blueprint that
auto-resolved its model binding before OpenRouter was enabled would start demanding manual
selection. Fix: when several models match, prefer the one from the earlier gateway in
`getActiveGateways()` order (Cloudflare, then OpenRouter), and only give up when the tie is within a
single gateway. This is a behavior-preserving change, and it is the one place where the gateway tag
on `AiModelInfo` is load-bearing rather than decorative.

**Untouched:** the chat model dropdown and the gatekeeper picker render `listModels()` names and
continue to work; they inherit the gateway tag only if we later choose to show it.

## Configuration

```
OPENROUTER_API_KEY=sk-or-v1-...          # presence enables the gateway
OPENROUTER_MODELS=id1,id2                # optional; overrides the curated built-ins
OPENROUTER_QUICK_MODEL=anthropic/claude-haiku-4.5   # optional
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1    # optional; for proxies
```

Independent of `CF_AI_GATEWAY*`. Neither set → today's behavior exactly (direct BYOK only).

## Testing

- `ai-models.test.ts` — OpenRouter handle with the platform key: base URL, bearer auth,
  `openai-completions`
  dispatch, catalog cost resolution, `reasoning: {effort: "medium"}` on the wire for a `thinkingFormat:
  "openrouter"` model and absent for a non-reasoning one.
- New `ai-gateway.test.ts` cases — registry with: CF only, OpenRouter only, both (merged list order,
  quick-model preference), neither.
- `agent-compaction.test.ts` — token limits for a curated OpenRouter id and for an unlisted one
  (128k default).
- `chat-attachment-validation.test.ts` — OpenRouter accepts text/image, rejects PDF.
- `ai-models.test.ts` — `getModel()` with a `userGateway` present and an OpenRouter config routes
  through the platform gateway instead of throwing (the latent-failure guard).
- `ai-models.test.ts` — an OpenRouter Claude handle emits `cache_control` (compat passthrough), and
  the model descriptor's `compat` is the catalog object rather than a hand-built one.
- `ai-gateway.test.ts` — `resolveModel()` profiles carry no gateway tag (chat-log leak guard).
- Frontend — Combobox filtering, the 8-model search threshold, pill text per gateway, and
  `findSuggestedModelId()` resolving to the Cloudflare model when both gateways offer the same one.

## Risks

| Risk | Mitigation |
|---|---|
| Catalog price/window drift from OpenRouter's live values | Documented; refresh by bumping pi-ai. Cost is already best-effort UI accounting. |
| Platform OpenRouter key spent without per-user metering | Accepted: company-funded internal app, limits flow off. Revisit only if `ENABLE_CLOUDFLARE_LIMITS` is turned on. |
| Attachment behavior differs between the same model on the two gateways (PDF works via CF/Anthropic, not via OpenRouter) | Validation rejects PDFs for OpenRouter at upload with a clear message; the model's gateway is visible in the pill. |
| `AiGatewayInfo` shape change | Additive; the three consumers are all in-repo and capnweb validation shapes are generated. |
| Same model reachable twice (Cloudflare and OpenRouter) confuses users or blueprint matching | The gateway pill names the route; `findSuggestedModelId()` tie-breaks by gateway order. |
| Prompt caching silently lost via OpenRouter | `compat` passthrough plus a `cache_control` test. |

## Files to change

**Backend:** `workshop-shared/src/api.ts` (types, `SUGGESTED_MODELS`) · `ai-gateway.ts` (registry +
`OpenRouterModelGateway`) · `ai-models.ts` (`catalogModel`, `getModelDirect`, `getModel` dispatch +
the non-fatal `userGateway` guard, `apiExtras`) · `chat-attachment-validation.ts` · `user.ts`
(`listModels`/`addModel`/`deleteModel` via registry) · `server.ts` (`getAiConfig`) ·
`agent-compaction.ts` (guarded lookup) · **`src/env.d.ts`** (declare the `OPENROUTER_*` vars —
nothing typechecks without this).

Untouched by this work: `limits.ts`, `ai-gateway-billing/**`, and the usage-check call site in
`overseer.ts`.

**Frontend:** `AddModelModal.tsx` (Combobox + OpenRouter entries) · `routes/providers.tsx` (pill,
delete `isBuiltIn`, notice) · `OnboardingWizard.tsx` (pill, conditional search) ·
`BlueprintLandingPage.tsx` (`findSuggestedModelId` tie-break).

**Tooling:** **`run-dev-server.js`** — add the `OPENROUTER_*` vars to the forwarded-env list
(lines ~242-248), otherwise the feature cannot be exercised in local dev.

**Docs:** `docs/ai-gateway-billing.md` (OpenRouter always platform-paid and quota-counted) ·
`docs/public-server.md` (new env vars) · `.gitignore` (`.superpowers/`).

## Checked and found not to be problems

Recorded so they aren't re-investigated during implementation:

- **Model id collisions.** OpenRouter ids are vendor-namespaced (`anthropic/claude-sonnet-5`), so
  they never collide with Cloudflare-gateway ids (`claude-sonnet-5`) in `resolveModel()` or in
  `listModels()`'s dedupe. The only ambiguity is the blueprint *matcher*, handled above.
- **Cloudflare-specific headers leaking to OpenRouter.** `cf-aig-*` headers are added only on
  gateway paths, and pi sends session-affinity headers only when the model's compat sets
  `sendSessionAffinityHeaders` — which OpenRouter catalog entries do not.
- **Analytics.** `analytics.ts` records connection *type* (`ai_model`), not provider or gateway.
  Nothing to change.
- **Admin settings / provisioning policy.** Neither gates providers; AI config stays env-driven by
  design (`admin-config.ts`).
- **Blueprint export.** `suggestedModel` is written from the bound model's `{provider, modelName}`,
  which round-trips fine for an OpenRouter model (`{openrouter, anthropic/claude-sonnet-5}` matches
  on `model.id === modelName`).
- **PDF bridging.** `bridgePdfAttachments()` dispatches on the model's API, so `openai-completions`
  is correctly untouched; the attachment validator rejects PDFs for OpenRouter at upload.

## Open items

None blocking. Deferred by choice: OpenRouter OAuth/per-user billing, dynamic catalog browsing,
inline `usage: { include: true }` cost reporting (needs a pi-ai escape hatch for extra body params).
