import { AiGatewayId, AiGatewayInfo, AiModelConfig, AiModelInfo, AiModelProvider, SUGGESTED_MODELS }
  from "@gadgets/workshop-shared/api";
import { UserAiModelRecord } from "./user.js";

// The model used for quick tasks like title generation when AI Gateway mode is active.
//
// This 70B model is quite fast and cheap and produces pretty good titles. The cost is insignificant
// compared to the actual coding model so there's not much reason to use a smaller model.
const QUICK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Providers whose pi API adapter refuses a custom fetch, so their inference cannot ride the
 * Workers AI binding and needs CF_AI_GATEWAY_API_TOKEN over HTTPS. pi's Google adapter throws
 * "Custom fetch is not supported by the Google Generative AI adapter" whenever the fetch it is
 * given is not globalThis.fetch, and the client it builds on offers no hook to route around that:
 * @google/genai's `GoogleGenAI` takes only `httpOptions`, whose knobs are
 * baseUrl/apiVersion/headers/timeout/extraBody/retryOptions.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-generative-ai.ts#L80
 *
 * pi's Vertex adapter throws the same way, so a google-vertex provider would belong here too; it
 * is absent only because this deployment has no such provider.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-vertex.ts#L98
 */
const HTTPS_ONLY_PROVIDERS = new Set(["google"]);

/**
 * A deployment-managed source of built-in models, holding the platform's credentials. Callers go
 * through the registry functions below rather than naming a concrete gateway, so adding a third
 * gateway stays additive.
 */
export interface ModelGateway {
  readonly id: AiGatewayId;
  readonly label: string;
  /**
   * Providers this gateway serves. Disjoint across gateways: "openrouter" belongs to the
   * OpenRouter gateway, every other provider to the Cloudflare one.
   */
  readonly providers: Set<string>;
  /** Built-in models offered to users, each tagged with this gateway's id. */
  getModelList(): AiModelInfo[];
  /**
   * Look up a built-in by id. The returned profile is a bare AiChatAuthorInfo: it is stamped onto
   * every persisted chat message, so it must never carry the gateway tag.
   */
  resolveModel(modelId: string): UserAiModelRecord | undefined;
  getQuickModelConfig(): AiModelConfig | undefined;
}

export class CloudflareModelGateway implements ModelGateway {
  readonly id = "cloudflare" as const;
  readonly label = "Cloudflare AI Gateway";
  readonly gateway: string;
  /**
   * The gateway name for Workers-AI-binding calls (webFetch's toMarkdown): binding calls only
   * reach gateways in the Worker's own account, so this is the platform gateway whenever the
   * binding transport is active, and unset when it isn't (see {@link binding}).
   */
  readonly sameAccountGateway?: string;
  readonly accountId: string;
  readonly apiToken?: string;
  /**
   * Workers AI binding, used as the gateway transport whenever present unless
   * CF_AI_GATEWAY_USE_BINDING=false opts out: binding requests are pre-authenticated in-account,
   * so inference and cost-log reads need no API token. Binding requests only reach gateways in
   * the Worker's own account, and the Worker can't verify that itself (it can't discover its own
   * account ID), so deployments whose gateway lives in a DIFFERENT account must set the opt-out
   * and use CF_AI_GATEWAY_API_TOKEN over HTTPS. Absent in local dev unless run-dev-server is
   * started with --use-workers-ai-binding.
   *
   * Such a deployment opts out with the flag rather than by unbinding WORKERS_AI, because the
   * binding is not only the gateway transport: webFetch's document-to-Markdown conversion calls
   * `env.ai.toMarkdown()` through it (see web-fetch.ts), so unbinding would break that too.
   */
  readonly binding?: Ai;
  readonly providers: Set<string>;

  constructor(env: Cloudflare.Env) {
    this.gateway = env.CF_AI_GATEWAY!;
    if (!env.CF_AI_GATEWAY_ACCOUNT_ID) {
      throw new Error("CF_AI_GATEWAY_ACCOUNT_ID is required when CF_AI_GATEWAY is set.");
    }
    this.accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
    this.apiToken = env.CF_AI_GATEWAY_API_TOKEN || undefined;
    // Normalized once, so a stray " False " opts out rather than reading as unset and silently
    // picking the other transport.
    const useBinding = env.CF_AI_GATEWAY_USE_BINDING?.trim().toLowerCase();
    this.binding = useBinding === "false"
        ? undefined
        : (env as { WORKERS_AI?: Ai }).WORKERS_AI;
    if (useBinding === "true" && !this.binding) {
      throw new Error(
          "CF_AI_GATEWAY_USE_BINDING requires the WORKERS_AI binding; without it the config " +
          "would silently fall back to the HTTPS transport.");
    }
    if (!this.apiToken && !this.binding) {
      throw new Error(
          "AI Gateway mode needs a transport: bind Workers AI (WORKERS_AI; in local dev start " +
          "with --use-workers-ai-binding) or set CF_AI_GATEWAY_API_TOKEN (a Run + Read token).");
    }
    this.sameAccountGateway = this.binding ? this.gateway : undefined;
    this.providers = new Set(
      (env.CF_AI_GATEWAY_PROVIDERS || "").split(",").map(s => s.trim()).filter(s => s !== "")
    );
    const httpsOnly = [...this.providers].filter(p => HTTPS_ONLY_PROVIDERS.has(p));
    if (httpsOnly.length > 0 && !this.apiToken) {
      const names = httpsOnly.join(", ");
      throw new Error(
          `${names} inference cannot ride the Workers AI binding transport, so enabling the ` +
          `${names} provider${httpsOnly.length > 1 ? "s" : ""} requires ` +
          "CF_AI_GATEWAY_API_TOKEN.");
    }
  }

  /**
   * Transport for a provider's gateway inference: the Workers AI binding when present, except for
   * the providers in {@link HTTPS_ONLY_PROVIDERS}, which ride HTTPS with the token (the
   * constructor guarantees a token whenever one of them is an enabled provider).
   */
  bindingFor(provider: string): Ai | undefined {
    return HTTPS_ONLY_PROVIDERS.has(provider) ? undefined : this.binding;
  }

  /**
   * Get the list of models available through AI Gateway, as AiModelInfo entries.
   */
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

  /**
   * Look up an AI Gateway model by ID. Returns a UserAiModelRecord if the model is a
   * SUGGESTED_MODEL for an enabled gateway provider, or undefined otherwise.
   */
  resolveModel(modelId: string): UserAiModelRecord | undefined {
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider) && modelId in models) {
        return {
          profile: { type: "agent", id: modelId, name: models[modelId].name },
          config: {
            provider: provider as AiModelConfig["provider"],
            model: modelId,
            // apiToken and apiUrl are ignored when AI Gateway mode is active -- getModel()
            // reads the real values from env. We set them to empty strings here to satisfy
            // the type.
            apiToken: "",
          },
        };
      }
    }
    return undefined;
  }

  /**
   * Get the AiModelConfig for the quick model (used for title generation).
   */
  getQuickModelConfig(): AiModelConfig | undefined {
    // Always use Workers AI here.
    return {
      provider: "cloudflare",
      model: QUICK_MODEL_ID,
      apiToken: "",
    };
  }
}

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
  /** OpenRouter ids are vendor-namespaced, so this gateway owns exactly one provider. */
  readonly providers = new Set<string>(["openrouter"]);
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly quickModel: string;
  /** Offered built-in ids, in display order. */
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

/** Identifies the Gateway and credentials needed to retrieve an inference log. */
export type AiGatewayLogRoute =
  | { gateway: string }
  | { gateway: string; accountId: string; apiToken: string };

/** Indicates a transient AI Gateway log lookup failure that should be retried. */
export class AiGatewayLogRetryableError extends Error {}

function validateLogCost(cost: unknown): number {
  if (cost === undefined || cost === null) {
    throw new AiGatewayLogRetryableError("AI Gateway log cost is not available yet.");
  }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error("AI Gateway log response contained an invalid cost.");
  }
  return cost;
}

/** Retrieve the cost recorded for an AI Gateway log. */
export async function getAiGatewayLogCost(
    env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string): Promise<number> {
  if (!("accountId" in route)) {
    let log: AiGatewayLog;
    try {
      log = await env.WORKERS_AI.gateway(route.gateway).getLog(logId);
    } catch (error) {
      throw new AiGatewayLogRetryableError("AI Gateway binding log request failed.", {
        cause: error,
      });
    }
    return validateLogCost(log.cost);
  }

  let url = "https://api.cloudflare.com/client/v4/accounts/" +
      `${encodeURIComponent(route.accountId)}/ai-gateway/gateways/` +
      `${encodeURIComponent(route.gateway)}/logs/${encodeURIComponent(logId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${route.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log request failed.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 408 || response.status === 429 ||
        response.status >= 500) {
      throw new AiGatewayLogRetryableError(
          `AI Gateway log request failed with status ${response.status}.`);
    }
    throw new Error(`AI Gateway log request failed with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log response could not be read.", {
      cause: error,
    });
  }
  if (typeof body !== "object" || body === null || !("success" in body) ||
      body.success !== true || !("result" in body) ||
      typeof body.result !== "object" || body.result === null) {
    throw new Error("AI Gateway log response was malformed.");
  }

  let cost = "cost" in body.result ? body.result.cost : undefined;
  return validateLogCost(cost);
}
