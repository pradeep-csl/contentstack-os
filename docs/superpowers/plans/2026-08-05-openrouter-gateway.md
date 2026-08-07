# OpenRouter Peer AI Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenRouter a deployment-managed peer of Cloudflare AI Gateway, so its models appear as built-ins in every model list and picker and are served with the company's platform key.

**Architecture:** `ai-gateway.ts` gains a `ModelGateway` interface with two implementations (Cloudflare — the existing class, renamed; OpenRouter — new) plus a registry facade. `ai-models.ts` routes `provider: "openrouter"` models through pi's existing `openai-completions` API with the platform key. `listModels()` returns models tagged with the gateway that serves them, and the UI shows that tag in the pill slot currently occupied by `built-in`.

**Tech Stack:** TypeScript (strict), Cloudflare Workers + Durable Objects, `@earendil-works/pi-ai` 0.83.0, vitest (`@cloudflare/vitest-pool-workers` for backend), React 19 + `@cloudflare/kumo` 2.9, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-05-openrouter-gateway-design.md`

## Global Constraints

- **No BYOK for OpenRouter.** Every OpenRouter request uses `env.OPENROUTER_API_KEY`. A stored config's `apiToken` is never read for this provider. Do not add token fields, OAuth, or balance checks.
- **Do not modify** `workshop-shared/src/limits.ts`, `ai-gateway-billing/**`, or the `checkUsageAndBalance` call site in `overseer.ts`.
- **pi imports are per-provider.** Import `OPENROUTER_MODELS` from `@earendil-works/pi-ai/providers/openrouter.models`. Never import `providers/all` (it bundles ~30 providers).
- **The descriptor's `provider` must be exactly `"openrouter"`.** pi's `detectCompat()` keys the whole OpenRouter dialect off `model.provider` / `model.baseUrl`: it derives `thinkingFormat: "openrouter"`, `sessionAffinityFormat: "openrouter"`, and `cacheControlFormat: "anthropic"` for `anthropic/*` ids (which is what makes prompt caching work over this dialect). Get the provider string wrong and all of that silently reverts to plain-OpenAI behavior. Pass catalog `compat` as well (`compat: catalog?.compat`) — `getCompat()` merges it over the detected defaults per key, adding model-specific refinements.
- **Only `getModelList()` may carry the gateway tag.** `resolveModel()` must keep returning a bare `AiChatAuthorInfo` — its profile is stamped onto every persisted chat message.
- **Gateway order is Cloudflare, then OpenRouter** — everywhere (merged lists, quick-model preference, blueprint tie-break).
- **Curated OpenRouter ids and windows** (exact values, taken from pi's catalog):
  `anthropic/claude-sonnet-5` 1000000 · `anthropic/claude-opus-5` 1000000 · `openai/gpt-5.6-sol` 1050000 (outputLimit 128000) · `google/gemini-3.6-flash` 1048576 · `moonshotai/kimi-k2.7-code` 262144 · `z-ai/glm-4.7` 202752
- **Env vars:** `OPENROUTER_API_KEY` (presence enables), `OPENROUTER_MODELS` (CSV override), `OPENROUTER_QUICK_MODEL` (default `anthropic/claude-haiku-4.5`), `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`).
- **Backend tests:** `cd packages/workshop-backend && pnpm vitest run <file>`. **Frontend tests:** `cd packages/workshop-frontend && pnpm vitest run <file>`. Typecheck: `pnpm -w run types:check`.
- **Commit style:** `feat:` / `test:` / `docs:` prefix, imperative mood, no trailing period.

## File Structure

**Modified — backend**
- `packages/workshop-shared/src/api.ts` — `AiModelProvider`, new `AiGatewayId` / `AiModelInfo`, `AiGatewayInfo`, `SUGGESTED_MODELS.openrouter`
- `packages/workshop-backend/src/ai-gateway.ts` — `ModelGateway` interface, `CloudflareModelGateway` (renamed from `AiGatewayConfig`), `OpenRouterModelGateway`, registry facade, pure `mergeModelLists()`
- `packages/workshop-backend/src/ai-models.ts` — `catalogModel`, `openRouterModel()` descriptor, `getModel` dispatch + non-fatal `userGateway` guard, `apiExtras` reasoning branch
- `packages/workshop-backend/src/chat-attachment-validation.ts` — provider entry
- `packages/workshop-backend/src/agent-compaction.ts` — guarded provider lookup
- `packages/workshop-backend/src/user.ts` — `listModels` / `addModel` / `deleteModel` through the registry
- `packages/workshop-backend/src/server.ts` — `getAiConfig` reports gateways
- `packages/workshop-backend/src/env.d.ts` — declare `OPENROUTER_*`
- `run-dev-server.js` — forward `OPENROUTER_*` in dev

**Created — frontend**
- `packages/workshop-frontend/src/modelListDisplay.ts` (+ `.test.ts`) — `gatewayLabel()`, `shouldShowModelSearch()`, `filterModels()`. Pure, so the three list surfaces share one behavior and it is unit-testable without rendering.
- `packages/workshop-frontend/src/suggestedModelMatch.ts` (+ `.test.ts`) — `findSuggestedModelId()` extracted out of `BlueprintLandingPage.tsx` with the gateway tie-break.

**Modified — frontend**
- `routes/providers.tsx` — gateway pill, delete `isBuiltIn()`, gateway-aware notice, search via shared helper
- `OnboardingWizard.tsx` — gateway pill, conditional search
- `AddModelModal.tsx` — `Select` → `Combobox`, OpenRouter labels
- `BlueprintLandingPage.tsx` — use the extracted matcher

**Modified — docs**
- `docs/ai-gateway-billing.md`, `docs/public-server.md`

---

### Task 1: Provider, curated catalog, and the two `Record`-keyed guards

Adding `"openrouter"` to `AiModelProvider` breaks compilation everywhere a `Record<AiModelProvider, …>` is declared. This task adds the provider and fixes every such site, so the tree compiles again before any routing exists.

**Files:**
- Modify: `packages/workshop-shared/src/api.ts:920` (provider union), `:922-928` (`AiGatewayInfo`), `:957-988` (`SUGGESTED_MODELS`), `:1750-1767` (add `AiModelInfo` after `AiChatAuthorInfo`)
- Modify: `packages/workshop-backend/src/chat-attachment-validation.ts:35-41`
- Modify: `packages/workshop-backend/src/agent-compaction.ts:28`
- Test: `packages/workshop-backend/__tests__/chat-attachment-validation.test.ts`, `packages/workshop-backend/__tests__/agent-compaction.test.ts`

**Interfaces:**
- Produces: `AiModelProvider` including `"openrouter"`; `type AiGatewayId = "cloudflare" | "openrouter"`; `type AiModelInfo = AiChatAuthorInfo & { gateway?: AiGatewayId }`; `AiGatewayInfo` with a `gateways: {id, label}[]` member on the enabled branch; `SUGGESTED_MODELS.openrouter` keyed by the six curated ids.

- [ ] **Step 1: Write the failing attachment test**

Add to `packages/workshop-backend/__tests__/chat-attachment-validation.test.ts` (inside the existing top-level `describe`):

```ts
it("allows text and images but not PDFs for OpenRouter", () => {
  expect(() => assertChatAttachmentSupportedByProvider("openrouter", "image/png", 1))
      .not.toThrow();
  expect(() => assertChatAttachmentSupportedByProvider("openrouter", "text/plain", 1))
      .not.toThrow();
  // openai-completions payloads have no native document input, so PDFs are rejected at upload.
  expect(() => assertChatAttachmentSupportedByProvider("openrouter", "application/pdf", 1))
      .toThrow();
});
```

- [ ] **Step 2: Write the failing compaction test**

Add to `packages/workshop-backend/__tests__/agent-compaction.test.ts` (beside the existing `getModelTokenLimits` cases):

```ts
it("sizes a curated OpenRouter model from SUGGESTED_MODELS", () => {
  expect(getModelTokenLimits(
      {provider: "openrouter", model: "openai/gpt-5.6-sol", apiToken: ""}))
      .toEqual({inputBudget: 1050000 - 128000, maxOutputTokens: 128000});
});

it("falls back to the default window for an uncurated OpenRouter model", () => {
  // Env-listed ids outside SUGGESTED_MODELS get the conservative 128k default: a model with a
  // larger real window simply compacts earlier than strictly necessary.
  expect(getModelTokenLimits(
      {provider: "openrouter", model: "deepseek/deepseek-v3.1-terminus", apiToken: ""}))
      .toEqual({inputBudget: 128_000, maxOutputTokens: undefined});
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd packages/workshop-backend && pnpm vitest run __tests__/chat-attachment-validation.test.ts __tests__/agent-compaction.test.ts`
Expected: FAIL — TypeScript rejects `"openrouter"` as an `AiModelProvider`.

- [ ] **Step 4: Add the provider, gateway id, and list type**

In `packages/workshop-shared/src/api.ts`, replace the provider union (line 920) with:

```ts
// Supported AI providers.
export type AiModelProvider =
    "openai" | "anthropic" | "google" | "cloudflare" | "ollama" | "openrouter";

// A deployment-managed source of built-in models, holding the platform's credentials.
export type AiGatewayId = "cloudflare" | "openrouter";
```

Replace `AiGatewayInfo` with:

```ts
// Information about the AI gateway configuration. Returned by `AuthenticatedApi.getAiConfig()`.
// `enabledProviders` is the union across all active gateways; `gateways` names them in routing
// order (Cloudflare first) so the UI can say which sources are live.
export type AiGatewayInfo = {
  enabled: true;
  enabledProviders: AiModelProvider[];
  gateways: {id: AiGatewayId, label: string}[];
} | {
  enabled: false;
};
```

- [ ] **Step 5: Add the curated OpenRouter models**

In the same file, add to `SUGGESTED_MODELS`, after the `"google"` block and before `"ollama"`:

```ts
  // OpenRouter ids are vendor-namespaced ("anthropic/claude-sonnet-5"), so they never collide
  // with the Cloudflare gateway's ids for the same model ("claude-sonnet-5"). Windows match
  // pi's OpenRouter catalog; override the offered set with OPENROUTER_MODELS.
  "openrouter": {
    "anthropic/claude-sonnet-5": {name: "Claude Sonnet 5", contextWindow: 1000000},
    "anthropic/claude-opus-5": {name: "Claude Opus 5", contextWindow: 1000000},
    "openai/gpt-5.6-sol": {
      name: "GPT 5.6 Sol", contextWindow: 1050000, outputLimit: 128000,
    },
    "google/gemini-3.6-flash": {name: "Gemini 3.6 Flash", contextWindow: 1048576},
    "moonshotai/kimi-k2.7-code": {name: "Kimi K2.7 Code", contextWindow: 262144},
    "z-ai/glm-4.7": {name: "GLM 4.7", contextWindow: 202752},
  },
```

Names are deliberately plain (no "(OpenRouter)" suffix): the gateway pill in the UI carries the origin, and the Add-Model dropdown groups by provider.

- [ ] **Step 6: Add the list-only `AiModelInfo` type**

In the same file, immediately after the `AiChatAuthorInfo` declaration (ends line 1767), add:

```ts
// A model as offered in pickers and settings lists. Extends AiChatAuthorInfo with the gateway
// that serves it, for the origin tag in the UI.
//
// IMPORTANT: only `listModels()` returns this. AiChatAuthorInfo is embedded in every chat
// message and stays lightweight, so a gateway-tagged profile must never reach the chat log --
// in particular AiGatewayConfig.resolveModel() keeps returning a bare AiChatAuthorInfo.
export type AiModelInfo = AiChatAuthorInfo & {
  gateway?: AiGatewayId;
};
```

- [ ] **Step 7: Keep the provider switch exhaustive**

`getModelDirect()` ends with `config.provider satisfies never` (`ai-models.ts:591`), so adding a provider to the union breaks the build until that switch handles it. Add this case before `default` in `packages/workshop-backend/src/ai-models.ts`:

```ts
    case "openrouter":
      // OpenRouter is always served by the deployment's platform key (see the gateway dispatch in
      // getModel()), so reaching the direct path means OPENROUTER_API_KEY is unset -- e.g. a
      // stored model that outlived the key. Fail with something actionable instead of sending a
      // keyless request and surfacing an opaque 401.
      throw new Error(
          "OpenRouter is not configured for this deployment. Set OPENROUTER_API_KEY, or pick " +
          "another model.");
```

- [ ] **Step 8: Fix the two provider-keyed records**

In `packages/workshop-backend/src/chat-attachment-validation.ts`, add to `ATTACHMENT_SUPPORT_BY_PROVIDER` (after `ollama`):

```ts
  openrouter: isTextOrImageMime,
```

and extend the comment above it: after "Workers AI and Ollama chat endpoints have no document input at all." add " OpenRouter is reached over the same OpenAI-completions dialect, so it is text + images too."

In `packages/workshop-backend/src/agent-compaction.ts`, make the lookup provider-safe (line 28):

```ts
  let model = SUGGESTED_MODELS[config.provider]?.[config.model];
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd packages/workshop-backend && pnpm vitest run __tests__/chat-attachment-validation.test.ts __tests__/agent-compaction.test.ts`
Expected: PASS

- [ ] **Step 10: Typecheck the whole workspace**

Run: `pnpm -w run types:check`
Expected: the only remaining errors are in `packages/workshop-frontend/src/AddModelModal.tsx` for `PROVIDER_LABELS` and `API_TOKEN_PLACEHOLDERS` (both `Record<AiModelProvider, string>` — grep confirms these plus the two backend sites fixed above are every provider-keyed record in the repo). Fix them now so the tree is green:

```ts
// in PROVIDER_LABELS
  openrouter: 'OpenRouter',
// in API_TOKEN_PLACEHOLDERS — unused while a gateway is configured (no BYOK for OpenRouter),
// present so the Record stays exhaustive.
  openrouter: 'sk-or-v1-...',
```

Re-run `pnpm -w run types:check` and expect it to pass.

- [ ] **Step 11: Commit**

```bash
git add packages/workshop-shared/src/api.ts \
        packages/workshop-backend/src/chat-attachment-validation.ts \
        packages/workshop-backend/src/agent-compaction.ts \
        packages/workshop-backend/src/ai-models.ts \
        packages/workshop-backend/__tests__/chat-attachment-validation.test.ts \
        packages/workshop-backend/__tests__/agent-compaction.test.ts \
        packages/workshop-frontend/src/AddModelModal.tsx
git commit -m "feat: add openrouter provider, curated model list, and attachment support"
```

---

### Task 2: `ModelGateway` registry with the OpenRouter gateway

**Files:**
- Modify: `packages/workshop-backend/src/ai-gateway.ts:1-99` (interface, rename, new gateway, facade)
- Modify: `packages/workshop-backend/src/env.d.ts:21` (declare `OPENROUTER_*` after the `CF_AI_GATEWAY_*` block)
- Modify: `run-dev-server.js:241-249` (forward the vars in dev)
- Test: `packages/workshop-backend/__tests__/ai-gateway.test.ts`

**Interfaces:**
- Consumes: `AiGatewayId`, `AiModelInfo`, `SUGGESTED_MODELS.openrouter` (Task 1).
- Produces:
  - `interface ModelGateway { readonly id: AiGatewayId; readonly label: string; readonly providers: Set<string>; getModelList(): AiModelInfo[]; resolveModel(id: string): UserAiModelRecord | undefined; getQuickModelConfig(): AiModelConfig | undefined }`
  - `class CloudflareModelGateway implements ModelGateway` (was `AiGatewayConfig`; `export { CloudflareModelGateway as AiGatewayConfig }` is **not** kept — call sites are updated in Tasks 3-4)
  - `class OpenRouterModelGateway implements ModelGateway` with extra members `readonly apiKey: string` and `readonly baseUrl: string`
  - `function getActiveGateways(env): ModelGateway[]`
  - `function getGatewayForProvider(env, provider: AiModelProvider): ModelGateway | undefined`
  - `function resolveGatewayModel(env, modelId: string): UserAiModelRecord | undefined`
  - `function mergeModelLists(gatewayEntries: AiModelInfo[], stored: AiModelInfo[]): AiModelInfo[]` — pure; gateway entries first, stored entries whose id already appears are dropped
  - `getAiGatewayConfig(env)` is kept, now returning `CloudflareModelGateway | null`

- [ ] **Step 1: Write the failing registry tests**

Create/extend `packages/workshop-backend/__tests__/ai-gateway.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  getActiveGateways, getGatewayForProvider, mergeModelLists, resolveGatewayModel,
} from "../src/ai-gateway.js";

const CF_ENV = {
  CF_AI_GATEWAY: "platform-gateway",
  CF_AI_GATEWAY_ACCOUNT_ID: "acct",
  CF_AI_GATEWAY_API_TOKEN: "cf-token",
  CF_AI_GATEWAY_PROVIDERS: "anthropic,cloudflare",
} as Cloudflare.Env;

const OR_ENV = { OPENROUTER_API_KEY: "sk-or-v1-test" } as Cloudflare.Env;
const BOTH_ENV = { ...CF_ENV, ...OR_ENV } as Cloudflare.Env;

describe("gateway registry", () => {
  it("reports no gateways when neither is configured", () => {
    expect(getActiveGateways({} as Cloudflare.Env)).toEqual([]);
  });

  it("lists Cloudflare before OpenRouter when both are configured", () => {
    expect(getActiveGateways(BOTH_ENV).map(g => g.id)).toEqual(["cloudflare", "openrouter"]);
  });

  it("routes providers to their owning gateway", () => {
    expect(getGatewayForProvider(BOTH_ENV, "anthropic")?.id).toBe("cloudflare");
    expect(getGatewayForProvider(BOTH_ENV, "openrouter")?.id).toBe("openrouter");
    // A provider the Cloudflare gateway wasn't enabled for has no gateway.
    expect(getGatewayForProvider(BOTH_ENV, "openai")).toBeUndefined();
    expect(getGatewayForProvider(CF_ENV, "openrouter")).toBeUndefined();
  });

  it("offers the curated OpenRouter models, tagged with their gateway", () => {
    const list = getActiveGateways(OR_ENV)[0].getModelList();
    expect(list.map(m => m.id)).toContain("anthropic/claude-sonnet-5");
    expect(list.every(m => m.gateway === "openrouter")).toBe(true);
  });

  it("honors OPENROUTER_MODELS as an override", () => {
    const env = { OPENROUTER_API_KEY: "k", OPENROUTER_MODELS: "z-ai/glm-4.7, deepseek/deepseek-r1" } as Cloudflare.Env;
    const list = getActiveGateways(env)[0].getModelList();
    expect(list.map(m => m.id)).toEqual(["z-ai/glm-4.7", "deepseek/deepseek-r1"]);
    // An id outside SUGGESTED_MODELS still gets a usable display name.
    expect(list[1].name).toBe("deepseek/deepseek-r1");
  });

  it("never tags a resolveModel profile (it lands in the chat log)", () => {
    const record = resolveGatewayModel(OR_ENV, "anthropic/claude-sonnet-5");
    expect(record?.config.provider).toBe("openrouter");
    expect(Object.keys(record!.profile).sort()).toEqual(["id", "name", "type"]);
  });

  it("prefers the Cloudflare quick model when both gateways are live", () => {
    expect(getActiveGateways(BOTH_ENV)[0].getQuickModelConfig()?.provider).toBe("cloudflare");
    expect(getActiveGateways(OR_ENV)[0].getQuickModelConfig())
        .toEqual({provider: "openrouter", model: "anthropic/claude-haiku-4.5", apiToken: ""});
  });

  it("merges gateway built-ins ahead of stored models and drops duplicates", () => {
    const merged = mergeModelLists(
        [{type: "agent", id: "a", name: "A", gateway: "openrouter"}],
        [{type: "agent", id: "a", name: "Stale A"}, {type: "agent", id: "b", name: "B"}]);
    expect(merged).toEqual([
      {type: "agent", id: "a", name: "A", gateway: "openrouter"},
      {type: "agent", id: "b", name: "B"},
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/workshop-backend && pnpm vitest run __tests__/ai-gateway.test.ts`
Expected: FAIL — `getActiveGateways` is not exported.

- [ ] **Step 3: Declare the env vars**

In `packages/workshop-backend/src/env.d.ts`, after the `CF_AI_GATEWAY_WAI_DIRECT` lines and their trailing note, add:

```ts
      // OpenRouter gateway: a peer of the Cloudflare AI Gateway. When OPENROUTER_API_KEY is set,
      // provider "openrouter" models are served with this platform key. There is no BYOK path for
      // OpenRouter -- a stored model config's apiToken is never used for it.
      OPENROUTER_API_KEY?: string;        // Platform key (enables the OpenRouter gateway)
      OPENROUTER_MODELS?: string;         // Comma-separated id override, e.g. "z-ai/glm-4.7,..."
      OPENROUTER_QUICK_MODEL?: string;    // Quick/title model when OpenRouter is the only gateway
      OPENROUTER_BASE_URL?: string;       // Defaults to https://openrouter.ai/api/v1
```

In `run-dev-server.js`, extend `OPTIONAL_FEATURE_VARS` after the `CF_AI_GATEWAY*` entries:

```js
    // OpenRouter gateway — peer of the CF AI Gateway; OPENROUTER_API_KEY enables it.
    "OPENROUTER_API_KEY", "OPENROUTER_MODELS", "OPENROUTER_QUICK_MODEL", "OPENROUTER_BASE_URL",
```

- [ ] **Step 4: Extract the interface and rename the Cloudflare gateway**

In `packages/workshop-backend/src/ai-gateway.ts`, change the imports and add the interface above the class:

```ts
import { AiChatAuthorInfo, AiGatewayId, AiModelConfig, AiModelInfo, AiModelProvider, SUGGESTED_MODELS }
  from "@gadgets/workshop-shared/api";
import { UserAiModelRecord } from "./user.js";

/**
 * A deployment-managed source of built-in models, holding the platform's credentials. Callers go
 * through the registry functions below rather than naming a concrete gateway, so adding a third
 * gateway stays additive.
 */
export interface ModelGateway {
  readonly id: AiGatewayId;
  readonly label: string;
  // Providers this gateway serves. Disjoint across gateways: "openrouter" belongs to the
  // OpenRouter gateway, every other provider to the Cloudflare one.
  readonly providers: Set<string>;
  // Built-in models offered to users, each tagged with this gateway's id.
  getModelList(): AiModelInfo[];
  // Look up a built-in by id. The returned profile is a bare AiChatAuthorInfo: it is stamped onto
  // every persisted chat message, so it must never carry the gateway tag.
  resolveModel(modelId: string): UserAiModelRecord | undefined;
  getQuickModelConfig(): AiModelConfig | undefined;
}
```

Rename `export class AiGatewayConfig` to `export class CloudflareModelGateway implements ModelGateway` and give it the two new members at the top of the class body:

```ts
  readonly id = "cloudflare" as const;
  readonly label = "Cloudflare AI Gateway";
```

Change its `getModelList()` return type to `AiModelInfo[]` and tag each entry:

```ts
  getModelList(): AiModelInfo[] {
    let result: AiModelInfo[] = [];
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider)) {
        for (let [id, model] of Object.entries(models)) {
          result.push({ type: "agent", id, name: model.name, gateway: this.id });
        }
      }
    }
    return result;
  }
```

Leave `resolveModel()` and `getQuickModelConfig()` untouched — `resolveModel` must stay untagged.

- [ ] **Step 5: Add the OpenRouter gateway**

Append after the `CloudflareModelGateway` class:

```ts
// Default model for quick tasks (titles, binding names, compaction summaries) when OpenRouter is
// the only active gateway. Cheap and fast; overridable with OPENROUTER_QUICK_MODEL.
const OPENROUTER_DEFAULT_QUICK_MODEL = "anthropic/claude-haiku-4.5";

const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter as a deployment-managed gateway. Enabled by OPENROUTER_API_KEY; every request uses
 * that platform key (there is no per-user OpenRouter credential anywhere in the product).
 */
export class OpenRouterModelGateway implements ModelGateway {
  readonly id = "openrouter" as const;
  readonly label = "OpenRouter";
  // OpenRouter ids are vendor-namespaced, so this gateway owns exactly one provider.
  readonly providers = new Set<string>(["openrouter"]);
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly quickModel: string;
  // Offered built-in ids, in display order.
  readonly modelIds: string[];

  constructor(env: Cloudflare.Env) {
    this.apiKey = env.OPENROUTER_API_KEY!;
    this.baseUrl = (env.OPENROUTER_BASE_URL || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.quickModel = env.OPENROUTER_QUICK_MODEL || OPENROUTER_DEFAULT_QUICK_MODEL;
    let override = (env.OPENROUTER_MODELS || "")
        .split(",").map(s => s.trim()).filter(s => s !== "");
    this.modelIds = override.length > 0
        ? override
        : Object.keys(SUGGESTED_MODELS.openrouter);
  }

  // Display name for an id: the curated entry's name, else the id itself (an OPENROUTER_MODELS
  // entry we don't curate is still perfectly usable -- pi's catalog supplies its cost/window).
  #displayName(modelId: string): string {
    return SUGGESTED_MODELS.openrouter[modelId]?.name ?? modelId;
  }

  getModelList(): AiModelInfo[] {
    return this.modelIds.map(id => (
        { type: "agent", id, name: this.#displayName(id), gateway: this.id }));
  }

  resolveModel(modelId: string): UserAiModelRecord | undefined {
    if (!this.modelIds.includes(modelId)) return undefined;
    return {
      // Bare AiChatAuthorInfo: this profile is stamped onto every persisted chat message.
      profile: { type: "agent", id: modelId, name: this.#displayName(modelId) },
      config: {
        provider: "openrouter",
        model: modelId,
        // Unused: OpenRouter always uses the platform key from env (see getModel()).
        apiToken: "",
      },
    };
  }

  getQuickModelConfig(): AiModelConfig | undefined {
    return { provider: "openrouter", model: this.quickModel, apiToken: "" };
  }
}
```

- [ ] **Step 6: Add the registry facade**

Replace the existing `getAiGatewayConfig` block with:

```ts
/**
 * Parse Cloudflare AI Gateway configuration. Returns null when CF_AI_GATEWAY is not set.
 * Prefer the registry functions below unless you specifically need Cloudflare-only fields.
 */
export function getAiGatewayConfig(env: Cloudflare.Env): CloudflareModelGateway | null {
  if (!env.CF_AI_GATEWAY) return null;
  return new CloudflareModelGateway(env);
}

/** The OpenRouter gateway, or null when OPENROUTER_API_KEY is not set. */
export function getOpenRouterGateway(env: Cloudflare.Env): OpenRouterModelGateway | null {
  if (!env.OPENROUTER_API_KEY) return null;
  return new OpenRouterModelGateway(env);
}

/**
 * Every active gateway, in routing order: Cloudflare first, then OpenRouter. The order is the
 * one source of truth for merged model lists, quick-model preference, and the blueprint
 * suggested-model tie-break.
 */
export function getActiveGateways(env: Cloudflare.Env): ModelGateway[] {
  let result: ModelGateway[] = [];
  let cloudflare = getAiGatewayConfig(env);
  if (cloudflare) result.push(cloudflare);
  let openrouter = getOpenRouterGateway(env);
  if (openrouter) result.push(openrouter);
  return result;
}

/** The gateway serving a provider, or undefined when no active gateway does. */
export function getGatewayForProvider(env: Cloudflare.Env, provider: AiModelProvider)
    : ModelGateway | undefined {
  return getActiveGateways(env).find(gateway => gateway.providers.has(provider));
}

/** Look up a built-in model across every active gateway, in gateway order. */
export function resolveGatewayModel(env: Cloudflare.Env, modelId: string)
    : UserAiModelRecord | undefined {
  for (let gateway of getActiveGateways(env)) {
    let record = gateway.resolveModel(modelId);
    if (record) return record;
  }
  return undefined;
}

/** The quick-task model of the first active gateway that offers one. */
export function getGatewayQuickModelConfig(env: Cloudflare.Env): AiModelConfig | undefined {
  for (let gateway of getActiveGateways(env)) {
    let config = gateway.getQuickModelConfig();
    if (config) return config;
  }
  return undefined;
}

/**
 * Merge gateway built-ins with a user's own stored models. Gateway entries come first and win:
 * a stored model whose id duplicates a built-in is dropped, so the gateway's routing and naming
 * are what the user sees.
 */
export function mergeModelLists(gatewayEntries: AiModelInfo[], stored: AiModelInfo[])
    : AiModelInfo[] {
  let ids = new Set(gatewayEntries.map(entry => entry.id));
  return [...gatewayEntries, ...stored.filter(entry => !ids.has(entry.id))];
}
```

- [ ] **Step 7: Run the registry tests**

Run: `cd packages/workshop-backend && pnpm vitest run __tests__/ai-gateway.test.ts`
Expected: PASS

- [ ] **Step 8: Fix the renamed-class call sites**

Run: `cd packages/workshop-backend && pnpm exec tsc --noEmit`
Expected: errors where `AiGatewayConfig` was used as a type — `src/ai-models.ts` (the `AiGatewayConfig` import and the `getModelViaGateway` parameter) and `src/user.ts`. Replace those type references with `CloudflareModelGateway`, importing it from `./ai-gateway.js`. Do not change behavior in this step.

Re-run `pnpm exec tsc --noEmit` and expect it to pass.

- [ ] **Step 9: Commit**

```bash
git add packages/workshop-backend/src/ai-gateway.ts \
        packages/workshop-backend/src/ai-models.ts \
        packages/workshop-backend/src/user.ts \
        packages/workshop-backend/src/env.d.ts \
        packages/workshop-backend/__tests__/ai-gateway.test.ts \
        run-dev-server.js
git commit -m "feat: add ModelGateway registry with an OpenRouter gateway"
```

---

### Task 3: Route OpenRouter requests

**Files:**
- Modify: `packages/workshop-backend/src/ai-models.ts:11-14` (catalog import), `:120-129` (`catalogModel`), `:280-284` (`apiExtras`), `:342-362` (`getModel` dispatch)
- Test: `packages/workshop-backend/__tests__/ai-models.test.ts`

**Interfaces:**
- Consumes: `getOpenRouterGateway`, `OpenRouterModelGateway` (Task 2); the `getModelDirect` `case "openrouter"` throw already added in Task 1 Step 7.
- Produces: `getModel(env, config, initiator, options)` handling `provider: "openrouter"`; unchanged signature.

- [ ] **Step 1: Write the failing routing tests**

Add a new `describe` block to `packages/workshop-backend/__tests__/ai-models.test.ts` (reuses the file's existing `env()`, `INITIATOR`, `captureRequest`, `capturedRequests`, `fetchStub`):

```ts
describe("OpenRouter gateway routing", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  const OR_CONFIG: AiModelConfig = {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5",
    apiToken: "never-used",
  };

  const orEnv = (overrides: Partial<Cloudflare.Env> = {}) =>
      env({ CF_AI_GATEWAY: undefined, OPENROUTER_API_KEY: "sk-or-v1-test", ...overrides });

  it("builds an openai-completions handle against OpenRouter", () => {
    const handle = getModel(orEnv(), OR_CONFIG, INITIATOR);
    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.provider).toBe("openrouter");
    expect(handle.model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(handle.model.contextWindow).toBe(1000000);
    // No AI Gateway log to read: cost falls back to pi's catalog-priced usage.
    expect(handle.aiGatewayLogRoute).toBeUndefined();
  });

  it("sends the platform key, not the config's token, plus attribution headers", async () => {
    const handle = getModel(orEnv({ PUBLIC_BASE_URL: "https://gadgets.example" }),
        OR_CONFIG, INITIATOR);
    const request = await captureRequest(handle);
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer sk-or-v1-test");
    expect(request.headers.get("http-referer")).toBe("https://gadgets.example");
    expect(request.headers.get("x-title")).toBe("Gadgets");
    // Cloudflare-only attribution must not leak to OpenRouter.
    expect(request.headers.get("cf-aig-metadata")).toBeNull();
  }, 15000);

  it("keeps the catalog's compat so Anthropic prompt caching still applies", async () => {
    const handle = getModel(orEnv(), OR_CONFIG, INITIATOR);
    const request = await captureRequest(handle);
    // pi emits cache_control only when compat.cacheControlFormat === "anthropic", which comes
    // from the catalog entry. Hand-built compat would silently disable prompt caching.
    expect(request.body).toContain("cache_control");
  }, 15000);

  it("requests medium reasoning for a reasoning-capable OpenRouter model", async () => {
    // pi's openrouter thinking branch reads options.reasoningEffort and emits a nested
    // `reasoning: {effort}` object. With no effort passed it emits `{effort: "none"}` instead --
    // i.e. thinking explicitly off -- so this assertion is what keeps reasoning switched on.
    const handle = getModel(orEnv(), OR_CONFIG, INITIATOR);
    const request = await captureRequest(handle);
    expect(JSON.parse(request.body).reasoning).toEqual({ effort: "medium" });
  }, 15000);

  it("honors OPENROUTER_BASE_URL", () => {
    const handle = getModel(orEnv({ OPENROUTER_BASE_URL: "https://proxy.example/or/v1/" }),
        OR_CONFIG, INITIATOR);
    expect(handle.model.baseUrl).toBe("https://proxy.example/or/v1");
  });

  it("ignores a Cloudflare user gateway it cannot serve instead of throwing", () => {
    // A connected+funded user's BYOK routing is passed for every model; Cloudflare unified
    // billing can't serve OpenRouter, so the platform gateway must take over silently.
    const handle = getModel(orEnv(), OR_CONFIG, INITIATOR, {
      userGateway: { accountId: "user-account-id", apiKey: "user-token" },
    });
    expect(handle.model.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("fails clearly when OpenRouter is not configured", () => {
    expect(() => getModel(env({ CF_AI_GATEWAY: undefined }), OR_CONFIG, INITIATOR))
        .toThrow("OpenRouter is not configured for this deployment.");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/workshop-backend && pnpm vitest run __tests__/ai-models.test.ts -t "OpenRouter gateway routing"`
Expected: FAIL — every case except "fails clearly when OpenRouter is not configured" throws `OpenRouter is not configured for this deployment.` (the Task 1 guard), because no gateway dispatch exists yet.

- [ ] **Step 3: Import the catalog and resolve OpenRouter models**

In `packages/workshop-backend/src/ai-models.ts`, add to the per-provider catalog imports (after the `OPENAI_MODELS` import):

```ts
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
```

Extend the imports from `./ai-gateway.js` to include `getOpenRouterGateway` and `OpenRouterModelGateway`.

In `catalogModel()`, add before the `ollama` case:

```ts
    case "openrouter": return (OPENROUTER_MODELS as Record<string, Model<Api>>)[modelId];
```

- [ ] **Step 4: Add the OpenRouter descriptor builder**

Add above `getModel()`:

```ts
// Attribution sent on OpenRouter requests so usage is identifiable in the OpenRouter dashboard.
const OPENROUTER_APP_TITLE = "Gadgets";

// Build the pi model descriptor for an OpenRouter model. OpenRouter speaks the OpenAI completions
// dialect, which pi already implements; the catalog supplies real cost, window, and compat.
//
// `provider: "openrouter"` is load-bearing, not decorative: pi's detectCompat() keys the whole
// dialect off it -- openrouter-format reasoning, openrouter session affinity, and
// cacheControlFormat "anthropic" for anthropic/* ids (which is what makes prompt caching work
// here). Catalog compat is merged over those detected defaults per key.
function openRouterModel(config: AiModelConfig, baseUrl: string): Model<Api> {
  const catalog = catalogModel(config.provider, config.model);
  return {
    id: config.model,
    name: catalog?.name ?? config.model,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl,
    reasoning: catalog?.reasoning ?? true,
    input: catalog?.input ?? ["text", "image"],
    cost: catalog?.cost ?? ZERO_COST,
    ...modelTokenWindow(config, catalog),
    thinkingLevelMap: catalog?.thinkingLevelMap,
    // sendSessionAffinityHeaders added after Task 3's review: pi only emits the affinity header
    // when compat sets it, and neither detectCompat nor the catalog entry does -- so OpenRouter
    // provider stickiness (which keeps consecutive turns on one upstream host, preserving cache
    // hits) would never engage. Same explicit opt-in workersAiCompat() makes.
    compat: { ...catalog?.compat, sendSessionAffinityHeaders: true },
  };
}

// Handle for an OpenRouter model served with the deployment's platform key. There is no BYOK
// path for OpenRouter, so the config's own apiToken is deliberately ignored.
function getModelViaOpenRouter(
  gateway: OpenRouterModelGateway,
  config: AiModelConfig,
  env: Cloudflare.Env,
  sessionAffinity?: string,
): ModelHandle {
  const headers: ProviderHeaders = { "X-Title": OPENROUTER_APP_TITLE };
  if (env.PUBLIC_BASE_URL) headers["HTTP-Referer"] = env.PUBLIC_BASE_URL;
  return makeHandle({
    model: openRouterModel(config, gateway.baseUrl),
    apiKey: gateway.apiKey,
    headers,
    // No cf-aig-metadata and no aiGatewayLogRoute: OpenRouter is not an AI Gateway. Per-turn
    // cost comes from pi's catalog-priced usage via the overseer's estimatedCost fallback.
    sessionAffinity,
  });
}
```

- [ ] **Step 5: Dispatch OpenRouter in `getModel()`**

Replace the body of `getModel()` up to (and including) the `userGateway` branch with:

```ts
  // OpenRouter is served by the deployment's platform key for every user, so it is decided before
  // any BYOK consideration: Cloudflare unified billing cannot route it at all.
  if (config.provider === "openrouter") {
    let openrouter = getOpenRouterGateway(env);
    if (!openrouter) {
      throw new Error(
          "OpenRouter is not configured for this deployment. Set OPENROUTER_API_KEY, or pick " +
          "another model.");
    }
    return getModelViaOpenRouter(openrouter, config, env, options.sessionAffinity);
  }

  // BYOK: a connected user's own Cloudflare account pays for everything Cloudflare unified
  // billing can serve, routed through the user's own AI Gateway. Providers it cannot serve fall
  // through to the platform paths below rather than throwing -- the overseer passes this routing
  // for every model once a user is connected and funded, so throwing here would break those
  // users on exactly the models their gateway can't bill. (This also retires the same latent
  // failure for Ollama, which hit the identical throw.)
  if (options.userGateway) {
    let handle = getModelViaUserGateway(
        config, buildMetadata(initiator, options.metadata), options.userGateway,
        options.sessionAffinity);
    if (handle) return handle;
  }
```

**Amended after Task 3's review (human ruling).** An earlier draft of this step used a hand-written
`servableByUserGateway(provider)` predicate listing the four servable providers. That duplicated the
set already encoded in `gatewayNativeModel()`'s switch, kept in sync only by a comment, with a silent
financial failure mode if the two ever drifted: a provider added to the switch but not the predicate
sends a connected BYOK user's request down the platform-funded path, so the platform pays instead of
the user's account, with no error and no log. Instead, make the switch the single definition of
"servable": change `getModelViaUserGateway()` to return `ModelHandle | undefined`, returning
`undefined` where it currently throws `Provider "..." is not supported via unified billing.`, and let
`getModel()` fall through on `undefined` as above. Keep the *why* comment about the overseer passing
this routing for every model.

Keep the rest of `getModel()` (the Cloudflare-gateway branch and the `getModelDirect` fallback)
unchanged. Note for accuracy: the fall-through only reaches `getModelDirect` when no platform gateway
is configured — with `CF_AI_GATEWAY` set, an Ollama config plus `userGateway` now lands on the
Cloudflare-gateway branch and throws its "not supported through AI Gateway" error instead.

- [ ] **Step 6: Add the reasoning branch**

In `makeHandle()`, extend `apiExtras` to cover OpenRouter-format thinking:

```ts
  const anthropicCompat = args.model.compat as AnthropicMessagesCompat | undefined;
  const apiExtras: Record<string, unknown> =
      args.model.api === "anthropic-messages"
          ? (anthropicCompat?.forceAdaptiveThinking === true ? { thinkingEnabled: true } : {}) :
      args.model.api === "openai-responses" ? { reasoningEffort: "medium" } :
      // OpenRouter: pi's openrouter thinking branch reads reasoningEffort and, when none is
      // passed, emits `reasoning: {effort: "none"}` -- thinking explicitly OFF. So a
      // reasoning-capable model needs an explicit level here or it silently degrades versus the
      // same model reached through a native provider API. `thinking: false` (one-shot calls) still
      // wins, since apiExtras is only spread when thinking is on.
      args.model.provider === "openrouter" && args.model.reasoning
          ? { reasoningEffort: "medium" } : {};
```

`reasoningEffort` is the option name in pi's `openai-completions` API type (`"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`) — the same knob the `openai-responses` branch above uses. Keying on `args.model.provider` rather than on `compat.thinkingFormat` matches how pi itself detects the dialect and avoids depending on the catalog carrying an explicit compat object.

- [ ] **Step 7: Run the routing tests**

Run: `cd packages/workshop-backend && pnpm vitest run __tests__/ai-models.test.ts`
Expected: PASS, including the pre-existing Cloudflare/Ollama/PDF cases.

If an assertion about the request body fails, print it (`console.log(request.body)`) and check it against `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` — adjust the assertion to what pi actually emits, but do not delete it.

- [ ] **Step 8: Commit**

```bash
git add packages/workshop-backend/src/ai-models.ts \
        packages/workshop-backend/__tests__/ai-models.test.ts
git commit -m "feat: route openrouter models through the platform key"
```

---

### Task 4: Wire the user + server APIs through the registry

**Files:**
- Modify: `packages/workshop-backend/src/user.ts:505-548` (`listModels`, `addModel`, `deleteModel`), `:670-695` (quick-model resolution in `getUserMeta`), `:565-578` (`setPreferredModel`)
- Modify: `packages/workshop-backend/src/server.ts:189-199` (`getAiConfig`)
- Test: `packages/workshop-backend/__tests__/ai-gateway.test.ts` (registry behavior already covered; add the `getAiConfig` shape helper test below)

**Interfaces:**
- Consumes: `getActiveGateways`, `resolveGatewayModel`, `getGatewayQuickModelConfig`, `mergeModelLists` (Task 2).
- Produces: `UserDurableObject.listModels(): Promise<AiModelInfo[]>`; `getAiConfig()` returning the `gateways` array.

- [ ] **Step 1: Write the failing test for the config shape**

Add to `packages/workshop-backend/__tests__/ai-gateway.test.ts`:

```ts
import { aiGatewayInfo } from "../src/ai-gateway.js";

describe("aiGatewayInfo", () => {
  it("reports disabled when no gateway is configured", () => {
    expect(aiGatewayInfo({} as Cloudflare.Env)).toEqual({ enabled: false });
  });

  it("reports the union of providers and both gateway labels", () => {
    expect(aiGatewayInfo(BOTH_ENV)).toEqual({
      enabled: true,
      enabledProviders: ["anthropic", "cloudflare", "openrouter"],
      gateways: [
        { id: "cloudflare", label: "Cloudflare AI Gateway" },
        { id: "openrouter", label: "OpenRouter" },
      ],
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/workshop-backend && pnpm vitest run __tests__/ai-gateway.test.ts -t aiGatewayInfo`
Expected: FAIL — `aiGatewayInfo` is not exported.

- [ ] **Step 3: Add `aiGatewayInfo()` to the registry**

Append to `packages/workshop-backend/src/ai-gateway.ts`:

```ts
/**
 * The client-visible AI configuration: whether any gateway is active, the union of providers they
 * serve (used to filter the Add-Model picker), and the gateways themselves in routing order.
 */
export function aiGatewayInfo(env: Cloudflare.Env): AiGatewayInfo {
  let gateways = getActiveGateways(env);
  if (gateways.length === 0) return { enabled: false };
  let providers = new Set<string>();
  for (let gateway of gateways) {
    for (let provider of gateway.providers) providers.add(provider);
  }
  return {
    enabled: true,
    enabledProviders: [...providers] as AiModelProvider[],
    gateways: gateways.map(gateway => ({ id: gateway.id, label: gateway.label })),
  };
}
```

Add `AiGatewayInfo` to the type import at the top of the file.

- [ ] **Step 4: Use it in `server.ts`**

Replace `getAiConfig()` (`packages/workshop-backend/src/server.ts:189`) with:

```ts
  getAiConfig(): Promise<AiGatewayInfo> {
    return Promise.resolve(aiGatewayInfo(this.env));
  }
```

Import `aiGatewayInfo` from `./ai-gateway.js` and drop the now-unused `getAiGatewayConfig` import if nothing else in the file uses it.

- [ ] **Step 5: Run the test**

Run: `cd packages/workshop-backend && pnpm vitest run __tests__/ai-gateway.test.ts`
Expected: PASS

- [ ] **Step 6: Route `listModels` through the registry**

Replace `UserDurableObject.listModels()` (`user.ts:505`) with:

```ts
  async listModels(): Promise<AiModelInfo[]> {
    // Built-ins from every active gateway (Cloudflare first, then OpenRouter), each tagged with
    // the gateway that serves it so the UI can show its origin.
    let gatewayEntries: AiModelInfo[] = [];
    for (let gateway of getActiveGateways(this.env)) {
      gatewayEntries.push(...gateway.getModelList());
    }
    let stored: AiModelInfo[] = this.storage.aiModels.list().map(model => model.profile);
    return mergeModelLists(gatewayEntries, stored);
  }
```

- [ ] **Step 7: Route the add/delete/preference guards through the registry**

In `addModel()`, replace the gateway check with:

```ts
  async addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    let gateways = getActiveGateways(this.env);
    if (gateways.length > 0 && !gateways.some(gw => gw.providers.has(config.provider))) {
      throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
    }

    profile.type = "agent";
    this.storage.aiModels.put({profile, config});
  }
```

In `deleteModel()`, replace the built-in scan with a registry lookup:

```ts
  async deleteModel(id: string): Promise<void> {
    // Built-in models belong to the deployment, not the user.
    let builtIn = resolveGatewayModel(this.env, id);
    if (builtIn) {
      throw new Error(`Cannot delete built-in model "${builtIn.profile.name}".`);
    }

    this.storage.aiModels.delete(id);
  }
```

In `setPreferredModel()`, replace `gwConfig?.resolveModel(id)` with `resolveGatewayModel(this.env, id)` and drop the local `gwConfig` variable.

In `getUserMeta()` (around lines 670-695), replace `gwConfig.resolveModel(modelId)` with `resolveGatewayModel(this.env, modelId)` and `gwConfig.getQuickModelConfig()` with `getGatewayQuickModelConfig(this.env)`, keeping the existing fallback to the user's own stored quick model when the registry returns nothing.

Update the file's import from `./ai-gateway.js` to bring in `getActiveGateways`, `resolveGatewayModel`, `getGatewayQuickModelConfig`, `mergeModelLists`, and add `AiModelInfo` to the `@gadgets/workshop-shared/api` import.

- [ ] **Step 8: Typecheck and run the full backend suite**

Run: `cd packages/workshop-backend && pnpm exec tsc --noEmit && pnpm vitest run`
Expected: PASS. `listModels()` widening to `AiModelInfo[]` must not produce errors — `AiModelInfo` is a superset of `AiChatAuthorInfo`. Two `overseer.ts` declarations forward this method and will need the same return type: the real one at `:7943` and the deny-stub at `:8915`. Widen both to `Promise<AiModelInfo[]>`.

- [ ] **Step 9: Commit**

```bash
git add packages/workshop-backend/src/ai-gateway.ts \
        packages/workshop-backend/src/user.ts \
        packages/workshop-backend/src/server.ts \
        packages/workshop-backend/src/overseer.ts \
        packages/workshop-backend/__tests__/ai-gateway.test.ts
git commit -m "feat: serve model lists and ai config from the gateway registry"
```

---

### Task 5: Shared frontend list-display helpers

One pure module so both list surfaces that show origins (providers page, onboarding) agree on pill text, the search threshold, and filtering. The chat model dropdown keeps rendering plain names and is not touched by this plan.

**Files:**
- Create: `packages/workshop-frontend/src/modelListDisplay.ts`
- Test: `packages/workshop-frontend/src/modelListDisplay.test.ts`

**Interfaces:**
- Consumes: `AiModelInfo`, `AiGatewayId` (Task 1).
- Produces: `gatewayLabel(gateway?: AiGatewayId): string | null`; `MODEL_SEARCH_THRESHOLD = 8`; `shouldShowModelSearch(count: number): boolean`; `filterModels(models: AiModelInfo[], query: string): AiModelInfo[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/workshop-frontend/src/modelListDisplay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AiModelInfo } from "@gadgets/workshop-shared/api";
import {
  filterModels, gatewayLabel, MODEL_SEARCH_THRESHOLD, shouldShowModelSearch,
} from "./modelListDisplay";

const MODELS: AiModelInfo[] = [
  {type: "agent", id: "@cf/zai-org/glm-5.2", name: "GLM 5.2", gateway: "cloudflare"},
  {type: "agent", id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", gateway: "openrouter"},
  {type: "agent", id: "claude-opus-5", name: "My Opus key"},
];

describe("gatewayLabel", () => {
  it("names the gateway serving a built-in model", () => {
    // "Cloudflare", not "Workers AI": that gateway also serves Anthropic/OpenAI/Google models.
    expect(gatewayLabel("cloudflare")).toBe("Cloudflare");
    expect(gatewayLabel("openrouter")).toBe("OpenRouter");
  });

  it("returns null for a model the user configured themselves", () => {
    expect(gatewayLabel(undefined)).toBeNull();
  });
});

describe("shouldShowModelSearch", () => {
  it("hides the search box until the list is long enough to need it", () => {
    expect(shouldShowModelSearch(2)).toBe(false);
    expect(shouldShowModelSearch(MODEL_SEARCH_THRESHOLD)).toBe(false);
    expect(shouldShowModelSearch(MODEL_SEARCH_THRESHOLD + 1)).toBe(true);
  });
});

describe("filterModels", () => {
  it("returns everything for a blank query", () => {
    expect(filterModels(MODELS, "   ")).toHaveLength(3);
  });

  it("matches name and id, case-insensitively", () => {
    expect(filterModels(MODELS, "sonnet").map(m => m.id)).toEqual(["anthropic/claude-sonnet-5"]);
    expect(filterModels(MODELS, "@CF/").map(m => m.id)).toEqual(["@cf/zai-org/glm-5.2"]);
  });

  it("matches the gateway label, so 'openrouter' narrows to that gateway", () => {
    expect(filterModels(MODELS, "openrouter").map(m => m.id))
        .toEqual(["anthropic/claude-sonnet-5"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/workshop-frontend && pnpm vitest run src/modelListDisplay.test.ts`
Expected: FAIL — cannot resolve `./modelListDisplay`.

- [ ] **Step 3: Implement the module**

Create `packages/workshop-frontend/src/modelListDisplay.ts`:

```ts
import type { AiGatewayId, AiModelInfo } from "@gadgets/workshop-shared/api";

// Pill text for the gateway serving a built-in model. This replaces the old generic "built-in"
// pill: naming the gateway says the same thing and more, in the same slot. A model with no
// gateway was added by the user with their own key, and gets no pill.
//
// "Cloudflare", not "Workers AI": that gateway serves Anthropic, OpenAI, and Google models too,
// so naming it after one of its providers would mislabel most of its rows.
const GATEWAY_LABELS: Record<AiGatewayId, string> = {
  cloudflare: "Cloudflare",
  openrouter: "OpenRouter",
};

export function gatewayLabel(gateway?: AiGatewayId): string | null {
  return gateway ? GATEWAY_LABELS[gateway] : null;
}

// Above this many models a list gets a search box. Mirrors the providers page, which already
// hides its search when there is nothing to search: a deployment with only Workers AI keeps the
// one-tap onboarding step, while both gateways together (~14 built-ins) get the filter.
export const MODEL_SEARCH_THRESHOLD = 8;

export function shouldShowModelSearch(count: number): boolean {
  return count > MODEL_SEARCH_THRESHOLD;
}

// Filter by display name, model id, or gateway label, so typing "openrouter" narrows to that
// gateway's models.
export function filterModels(models: AiModelInfo[], query: string): AiModelInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter(model => {
    const label = gatewayLabel(model.gateway) ?? "";
    return `${model.name} ${model.id} ${label}`.toLowerCase().includes(needle);
  });
}
```

- [ ] **Step 4: Run the test**

Run: `cd packages/workshop-frontend && pnpm vitest run src/modelListDisplay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-frontend/src/modelListDisplay.ts \
        packages/workshop-frontend/src/modelListDisplay.test.ts
git commit -m "feat: add shared model list display helpers"
```

---

### Task 6: Providers page — gateway pill and notice

**Files:**
- Modify: `packages/workshop-frontend/src/routes/providers.tsx:5-26` (imports, drop `PROVIDER_ORDER`), `:35-119` (`ModelRow`), `:133-206` (page state, drop `isBuiltIn`), `:224-267` (search + notices), `:302-315` (row props)

**Interfaces:**
- Consumes: `gatewayLabel`, `filterModels` (Task 5); `AiModelInfo`, `AiGatewayInfo.gateways` (Tasks 1, 4).

- [ ] **Step 1: Swap the model type and imports**

In `packages/workshop-frontend/src/routes/providers.tsx`, replace the shared-api import with:

```tsx
import {
  AiGatewayInfo,
  AiModelInfo,
} from '@gadgets/workshop-shared/api'
import { filterModels, gatewayLabel } from '../modelListDisplay'
```

Delete the `PROVIDER_ORDER` constant (line 26) and the `SUGGESTED_MODELS` / `AiModelProvider` / `AiChatAuthorInfo` imports.

- [ ] **Step 2: Replace the `built-in` pill with the gateway pill**

In `ModelRow`, change the props type from `model: AiChatAuthorInfo` / `isBuiltIn: boolean` to `model: AiModelInfo`, then replace the `isBuiltIn && (...)` block with:

```tsx
        {gatewayLabel(model.gateway) && (
          <span className="shrink-0 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-subtle">
            {gatewayLabel(model.gateway)}
          </span>
        )}
```

Replace the remaining `!isBuiltIn && (` guard around the delete menu item with `!model.gateway && (` — gateway-served models still can't be deleted.

- [ ] **Step 3: Delete the `isBuiltIn` heuristic**

In `ProvidersPage`, change `useState<AiChatAuthorInfo[]>([])` to `useState<AiModelInfo[]>([])`, delete the whole `isBuiltIn` function (lines 170-174), and drop the `isBuiltIn={isBuiltIn(model.id)}` prop from the `ModelRow` usage. The backend now states this directly; re-deriving it on the client was the only reason this page imported `SUGGESTED_MODELS`.

- [ ] **Step 4: Name the active gateways in the notice**

Replace the `gatewayMode && (<Notice>…)` body with:

```tsx
              <Notice>
                <Lightning size={15} className="mt-px shrink-0 text-kumo-brand" />
                <span>
                  <strong className="font-medium text-kumo-default">Built-in models</strong> are
                  managed by your deployment
                  {aiConfig?.enabled
                    ? ` (${aiConfig.gateways.map((g) => g.label).join(', ')})`
                    : ''}
                  . You can still add your own models with your own API tokens.
                </span>
              </Notice>
```

- [ ] **Step 5: Use the shared filter**

Replace the local `filtered` computation (lines 202-206) with:

```tsx
  const filtered = filterModels(models, search)
```

- [ ] **Step 6: Typecheck and verify manually**

Run: `cd packages/workshop-frontend && pnpm run types:check`
Expected: PASS.

Then run the app (`pnpm dev-server` in one shell, `pnpm dev-client` in another, with `OPENROUTER_API_KEY` and the `CF_AI_GATEWAY_*` vars exported) and confirm on `/providers`: OpenRouter models show an `OPENROUTER` pill, Cloudflare-gateway models show `CLOUDFLARE`, a self-added model shows no pill and still offers Delete, and the notice names both gateways.

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-frontend/src/routes/providers.tsx
git commit -m "feat: show the serving gateway on provider rows"
```

---

### Task 7: Onboarding step — pill and conditional search

**Files:**
- Modify: `packages/workshop-frontend/src/OnboardingWizard.tsx:7` (imports), `:87` (models state), `:495-577` (step 1 markup)

**Interfaces:**
- Consumes: `gatewayLabel`, `filterModels`, `shouldShowModelSearch` (Task 5); `AiModelInfo` (Task 1).

- [ ] **Step 1: Add the imports and search state**

Add to the shared-api import in `OnboardingWizard.tsx`: `AiModelInfo`. Add one new import:

```tsx
import { filterModels, gatewayLabel, shouldShowModelSearch } from './modelListDisplay'
```

Add `MagnifyingGlass` to the **existing** `@phosphor-icons/react` import (the one that already brings in `Check` and `Plus`) rather than adding a second import statement from the same module.

Change the models state to `useState<AiModelInfo[]>([])` and add beside it:

```tsx
  const [modelSearch, setModelSearch] = useState('')
```

Then, so the list is filtered once per render instead of three times, add just above the `return` (beside the other derived values):

```tsx
  const visibleModels = filterModels(models, modelSearch)
```

- [ ] **Step 2: Add the conditional search box**

In step 1, immediately after the `<p className="text-sm text-kumo-subtle mb-6">` block and before the `{modelsLoading ? (` ternary, insert:

```tsx
                {/* Search appears only once the list is long enough to need it (both gateways
                    active ≈ 14 models); a Workers-AI-only deployment keeps the one-tap step. */}
                {!modelsLoading && shouldShowModelSearch(models.length) && (
                  <div className="relative mb-3">
                    <MagnifyingGlass
                      size={16}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
                    />
                    <input
                      type="text"
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      placeholder="Search models…"
                      className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[13px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
                    />
                  </div>
                )}
```

- [ ] **Step 3: Render the filtered list with the pill**

Change `{models.map((model) => (` to `{visibleModels.map((model) => (`.

Replace the model-name paragraph (lines 538-540) with:

```tsx
                            <p className="text-sm font-medium text-kumo-default truncate">
                              {model.name}
                              {gatewayLabel(model.gateway) && (
                                <span className="ml-1.5 rounded-full bg-kumo-tint px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-subtle">
                                  {gatewayLabel(model.gateway)}
                                </span>
                              )}
                            </p>
```

Change the empty-state guard from `models.length === 0` to `visibleModels.length === 0`, and make its copy reflect both cases:

```tsx
                          <p className="text-sm text-kumo-subtle mb-1">
                            {models.length === 0 ? 'No models configured yet' : 'No models match your search'}
                          </p>
                          <p className="text-xs text-kumo-inactive">
                            {models.length === 0 ? 'Add a model to get started' : 'Try a different name'}
                          </p>
```

- [ ] **Step 4: Typecheck and verify manually**

Run: `cd packages/workshop-frontend && pnpm run types:check`
Expected: PASS.

In the running app, sign up as a fresh user to hit onboarding and confirm: with both gateways on the search box appears and filters (including by typing "openrouter"); each built-in row shows its gateway pill; with only `CF_AI_GATEWAY` set and ≤8 models there is no search box; the empty state from the original screenshot is unchanged when nothing is configured.

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-frontend/src/OnboardingWizard.tsx
git commit -m "feat: tag and search models in the onboarding step"
```

---

### Task 8: Add-Model dialog — searchable Combobox

**Files:**
- Modify: `packages/workshop-frontend/src/AddModelModal.tsx:2` (import), `:243-270` (the `Select` block)

**Interfaces:**
- Consumes: Kumo `Combobox` (`Root`, `TriggerInput`, `Input`, `List`, `Group`, `GroupLabel`, `Item`, `Empty`), already a dependency at 2.9.0. The `PROVIDER_LABELS` / `API_TOKEN_PLACEHOLDERS` OpenRouter entries landed in Task 1.

- [ ] **Step 1: Confirm the Combobox part names before writing markup**

Run: `grep -o '\(Root\|TriggerInput\|Trigger\|Input\|List\|Group\|GroupLabel\|Item\|Empty\|Value\|Content\)[A-Za-z]*:' packages/workshop-frontend/node_modules/@cloudflare/kumo/dist/index-DUCaDjfd.d.ts | sort -u`
Expected: the compound parts available on `Combobox`. Use the exact names printed; if `Root` is absent the component is used bare (`<Combobox …>`), as `Select` is in this file today.

- [ ] **Step 2: Swap `Select` for `Combobox`**

In the import on line 2, replace `Select` with `Combobox`. Replace the whole `<Select …>` element (lines 243-270) with:

```tsx
          {/* Combobox rather than Select: with both gateways active this list runs to ~20
              options, so it needs type-to-filter. Groups and values are unchanged. */}
          <Combobox.Root
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v as string)}
          >
            <Combobox.TriggerInput
              label={gatewayMode ? 'Select Provider' : 'Select Model'}
              className="w-full text-sm"
              placeholder={gatewayMode ? 'Choose a provider...' : 'Choose an AI model...'}
              error={errors.selection}
            />
            <Combobox.List>
              {groupedOptions.map((group, groupIndex) => (
                <Combobox.Group key={group.provider}>
                  {groupIndex > 0 && <div className="h-px bg-kumo-line my-1 mx-2" />}
                  <Combobox.GroupLabel className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                    {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                  </Combobox.GroupLabel>
                  {group.items.map((opt) => (
                    <Combobox.Item key={opt.value} value={opt.value}>
                      {opt.label}
                    </Combobox.Item>
                  ))}
                </Combobox.Group>
              ))}
              <Combobox.Empty className="px-3 py-2 text-xs text-kumo-subtle">
                No models match your search
              </Combobox.Empty>
            </Combobox.List>
          </Combobox.Root>
```

If Step 1 showed different part names (e.g. no `Root`, or `Trigger` + `Input` instead of `TriggerInput`), keep this structure and rename the parts to the ones the package exports — the type errors will point at each one. Do not fall back to `Select`.

Leave `decodeSelection`, `encodeSelection`, `groupedOptions`, the custom-model fields, and the credential fields untouched — OpenRouter arrives as one more group from the existing loop, and with a gateway configured `showCredentials` is already false so no token is prompted for. `buildOptions` gets exactly one guard, in the next step.

- [ ] **Step 3: Gate OpenRouter on a gateway that can serve it**

Task 1's review caught a reachable dead end, and the human ruled it gets fixed here: `buildOptions` only filters by `enabledProviders` when `gatewayMode` is true, so on a deployment with **no** gateway configured all six curated OpenRouter models are offered, the token field is required (OpenRouter is neither Ollama nor Cloudflare), the token is stored — and every use then throws `OpenRouter is not configured for this deployment`, because there is no BYOK path for this provider.

In `buildOptions`, immediately after the existing `if (enabledProviders && !enabledProviders.has(provider)) continue`, add:

```ts
    // OpenRouter is only ever served by the deployment's platform key (no BYOK), so it must not
    // be offered when no gateway serves it -- otherwise a no-gateway deployment lets a user add a
    // model with their own token that every request then rejects.
    if (provider === 'openrouter' && !enabledProviders?.has('openrouter')) continue
```

- [ ] **Step 4: Typecheck**

- [ ] **Step 3: Typecheck**

Run: `cd packages/workshop-frontend && pnpm run types:check`
Expected: PASS. If a Combobox prop name differs from `Select`'s, follow the type error rather than guessing.

- [ ] **Step 4: Verify manually**

In the running app, open **Add provider** on `/providers` and confirm: typing filters across groups; the OpenRouter group is present and lists "Other OpenRouter…"; keyboard up/down/enter selects; a non-matching query shows the empty state; selecting "Other OpenRouter…" then submitting a model id like `deepseek/deepseek-r1` adds a model that appears in the list and can be selected in chat.

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-frontend/src/AddModelModal.tsx
git commit -m "feat: make the add-model picker searchable"
```

---

### Task 9: Blueprint suggested-model tie-break

**Files:**
- Create: `packages/workshop-frontend/src/suggestedModelMatch.ts`
- Test: `packages/workshop-frontend/src/suggestedModelMatch.test.ts`
- Modify: `packages/workshop-frontend/src/BlueprintLandingPage.tsx:379-395` (replace the inline matcher with the import), `:48` (`const [models, setModels] = useState<AiChatAuthorInfo[]>([])`)

**Interfaces:**
- Consumes: `AiModelInfo`, `AiGatewayId` (Task 1).
- Produces: `findSuggestedModelId(models: AiModelInfo[], suggested: {provider: string, modelName: string}): string | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/workshop-frontend/src/suggestedModelMatch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AiModelInfo } from "@gadgets/workshop-shared/api";
import { findSuggestedModelId } from "./suggestedModelMatch";

const CF: AiModelInfo =
    {type: "agent", id: "claude-sonnet-5", name: "Claude Sonnet 5", gateway: "cloudflare"};
const OR: AiModelInfo = {
  type: "agent", id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", gateway: "openrouter",
};
const OWN: AiModelInfo = {type: "agent", id: "my-opus", name: "My Opus"};

describe("findSuggestedModelId", () => {
  it("matches a bare model name", () => {
    expect(findSuggestedModelId([CF, OWN], {provider: "anthropic", modelName: "claude-sonnet-5"}))
        .toBe("claude-sonnet-5");
  });

  it("matches a provider/model id", () => {
    expect(findSuggestedModelId([OR, OWN], {provider: "anthropic", modelName: "claude-sonnet-5"}))
        .toBe("anthropic/claude-sonnet-5");
  });

  it("prefers the earlier gateway when both offer the same model", () => {
    // Before this tie-break, two matches made the matcher give up and force manual selection --
    // a regression for blueprints that auto-resolved before OpenRouter was enabled.
    expect(findSuggestedModelId([OR, CF], {provider: "anthropic", modelName: "claude-sonnet-5"}))
        .toBe("claude-sonnet-5");
  });

  it("returns null when the tie is within one gateway", () => {
    const a: AiModelInfo =
        {type: "agent", id: "anthropic/claude-sonnet-5", name: "A", gateway: "openrouter"};
    const b: AiModelInfo =
        {type: "agent", id: "anthropic/claude-sonnet-5:beta", name: "B", gateway: "openrouter"};
    expect(findSuggestedModelId([a, b], {provider: "anthropic", modelName: "claude-sonnet"}))
        .toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(findSuggestedModelId([OWN], {provider: "google", modelName: "gemini-3.6-flash"}))
        .toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/workshop-frontend && pnpm vitest run src/suggestedModelMatch.test.ts`
Expected: FAIL — cannot resolve `./suggestedModelMatch`.

- [ ] **Step 3: Implement the matcher**

Create `packages/workshop-frontend/src/suggestedModelMatch.ts`:

```ts
import type { AiGatewayId, AiModelInfo } from "@gadgets/workshop-shared/api";

// Gateway preference for ties, mirroring the backend's routing order (Cloudflare, then
// OpenRouter). A model the user configured themselves has no gateway and sorts last.
const GATEWAY_RANK: Record<AiGatewayId, number> = { cloudflare: 0, openrouter: 1 };

function rank(model: AiModelInfo): number {
  return model.gateway ? GATEWAY_RANK[model.gateway] : 2;
}

// Pick the single model a blueprint's suggested {provider, modelName} refers to, or null when it
// stays ambiguous.
//
// Blueprints store the suggestion as loose text, so the same string can match the same model on
// two gateways -- e.g. {anthropic, claude-sonnet-5} matches both "claude-sonnet-5" (Cloudflare)
// and "anthropic/claude-sonnet-5" (OpenRouter). Resolve that by gateway order instead of giving
// up, which would force manual selection for blueprints that auto-resolved before OpenRouter was
// enabled. A tie *within* one gateway is genuinely ambiguous and still returns null.
export function findSuggestedModelId(
  models: AiModelInfo[],
  suggested: {provider: string, modelName: string},
): string | null {
  const provider = suggested.provider.trim().toLowerCase();
  const modelName = suggested.modelName.trim().toLowerCase();

  const pick = (candidates: AiModelInfo[]): string | null => {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].id;
    const sorted = [...candidates].sort((a, b) => rank(a) - rank(b));
    return rank(sorted[0]) < rank(sorted[1]) ? sorted[0].id : null;
  };

  const exact = pick(models.filter(model =>
    model.id.toLowerCase() === modelName ||
    model.name.toLowerCase() === modelName ||
    model.id.toLowerCase() === `${provider}/${modelName}` ||
    model.id.toLowerCase() === `${provider}:${modelName}`
  ));
  if (exact) return exact;

  return pick(models.filter(model => {
    const text = `${model.id} ${model.name}`.toLowerCase();
    return text.includes(provider) && text.includes(modelName);
  }));
}
```

- [ ] **Step 4: Run the test**

Run: `cd packages/workshop-frontend && pnpm vitest run src/suggestedModelMatch.test.ts`
Expected: PASS

- [ ] **Step 5: Use it in `BlueprintLandingPage.tsx`**

Delete the inline `findSuggestedModelId` `useCallback` (lines 379-395) and import the shared one:

```tsx
import { findSuggestedModelId as matchSuggestedModel } from './suggestedModelMatch'
```

Re-add a thin `useCallback` so the existing call sites and the `models` dependency keep working:

```tsx
  const findSuggestedModelId = useCallback(
    (suggested: {provider: string, modelName: string}) => matchSuggestedModel(models, suggested),
    [models])
```

Change the `models` state on line 48 to `useState<AiModelInfo[]>([])` and add `AiModelInfo` to the shared-api import (keep `AiChatAuthorInfo` if other code in the file still uses it).

- [ ] **Step 6: Typecheck and run the frontend suite**

Run: `cd packages/workshop-frontend && pnpm run types:check && pnpm vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-frontend/src/suggestedModelMatch.ts \
        packages/workshop-frontend/src/suggestedModelMatch.test.ts \
        packages/workshop-frontend/src/BlueprintLandingPage.tsx
git commit -m "feat: resolve blueprint model suggestions by gateway order"
```

---

### Task 10: Documentation and full verification

**Files:**
- Modify: `docs/public-server.md`, `docs/ai-gateway-billing.md`

- [ ] **Step 1: Document the env vars**

In `docs/public-server.md`, beside the existing AI Gateway configuration, add:

```markdown
### OpenRouter gateway

OpenRouter is a peer of the Cloudflare AI Gateway: set its key and its models appear as built-ins
alongside (or instead of) the Cloudflare ones, served with the deployment's own key.

```
OPENROUTER_API_KEY=sk-or-v1-...          # presence enables the gateway
OPENROUTER_MODELS=id1,id2                # optional; overrides the curated built-ins
OPENROUTER_QUICK_MODEL=anthropic/claude-haiku-4.5   # optional
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1    # optional; for proxies
```

Independent of `CF_AI_GATEWAY*` — enable either, both, or neither. With both, model lists merge
(Cloudflare first) and each built-in shows the gateway serving it. There is no per-user OpenRouter
credential: every OpenRouter request uses `OPENROUTER_API_KEY`.

Per-turn cost for OpenRouter models is priced from pi's model catalog rather than read from an AI
Gateway log, so it is an estimate that can drift from OpenRouter's actual charges; refresh it by
bumping `@earendil-works/pi-ai`.
```

- [ ] **Step 2: Note the billing interaction**

In `docs/ai-gateway-billing.md`, under "How it works", add:

```markdown
**OpenRouter models** are always served with the platform's `OPENROUTER_API_KEY`: Cloudflare
unified billing cannot route them, so a connected+funded user's BYOK routing is ignored for them
and the request goes out on the platform key. With `ENABLE_CLOUDFLARE_LIMITS` on, that means
OpenRouter turns taken by a funded user do not consume the daily free-tier counter. This is
intentional for a deployment where the company funds both keys; making the counter model-aware is
the follow-up if per-user metering is ever needed.
```

- [ ] **Step 3: Run every check**

Run: `pnpm -w run lint && pnpm -w run types:check`
Expected: PASS.

Then the test suites. Note that `pnpm -w run test` also runs the backend's **integration** suite (`vitest.integration.config.ts`, which boots `src/server.ts` under `@cloudflare/vitest-pool-workers`); if that suite fails for environment reasons unrelated to this work, run the unit suites and say explicitly which suite was skipped and why — do not report a partial run as green:

```bash
node --test scripts/*.test.js
cd packages/workshop-backend && pnpm vitest run
cd ../workshop-frontend && pnpm vitest run
```

Report any failure with its output rather than working around it.

- [ ] **Step 4: Verify the four deployment permutations by hand**

With the dev server running, confirm each: **neither** gateway set → only user-added models, no pills, unchanged behavior; **Cloudflare only** → today's behavior, `WORKERS AI`-style pills; **OpenRouter only** → curated OpenRouter built-ins, chat turn completes, a title is generated (proving the OpenRouter quick model works); **both** → merged list with Cloudflare first, correct pills, search present, chat works on a model from each gateway.

- [ ] **Step 5: Commit**

```bash
git add docs/public-server.md docs/ai-gateway-billing.md
git commit -m "docs: document the OpenRouter gateway"
```

---

## Notes for the implementer

- `docs/superpowers/` is gitignored in this repo, so the spec and this plan are local-only — don't try to commit them.
- The backend test command builds the browser runtime first; run it from `packages/workshop-backend` so `pnpm vitest` resolves the workspace config.
- `packages/workshop-backend/.wrangler/validate/**` is generated output. Never edit it; it regenerates on build.
- If a pi-ai API detail contradicts this plan (option name, wire field), trust the installed package under `packages/workshop-backend/node_modules/@earendil-works/pi-ai/dist` and adjust — then say so in the task's commit message.
