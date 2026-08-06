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
