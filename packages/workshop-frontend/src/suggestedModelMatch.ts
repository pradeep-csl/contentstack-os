import type { AiGatewayId, AiModelInfo } from "@gadgets/workshop-shared/api";

// Gateway preference for ties, mirroring the backend's routing order (Cloudflare, then
// OpenRouter). A model the user configured themselves has no gateway and sorts last.
const GATEWAY_RANK: Record<AiGatewayId, number> = { cloudflare: 0, openrouter: 1 };

function rank(model: AiModelInfo): number {
  return model.gateway ? GATEWAY_RANK[model.gateway] : 2;
}

/**
 * Pick the single model a blueprint's suggested {provider, modelName} refers to, or null when it
 * stays ambiguous.
 *
 * Blueprints store the suggestion as loose text, so the same string can match the same model on
 * two gateways -- e.g. {anthropic, claude-sonnet-5} matches both "claude-sonnet-5" (Cloudflare)
 * and "anthropic/claude-sonnet-5" (OpenRouter). Resolve that by gateway order instead of giving
 * up, which would force manual selection for blueprints that auto-resolved before OpenRouter was
 * enabled. A tie *within* one gateway is genuinely ambiguous and still returns null.
 */
export function findSuggestedModelId(
  models: AiModelInfo[],
  suggested: {provider: string, modelName: string},
): string | null {
  const provider = suggested.provider.trim().toLowerCase();
  const modelName = suggested.modelName.trim().toLowerCase();

  const pick = (candidates: AiModelInfo[]): string | null => {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].id;
    const sorted = candidates.toSorted((a, b) => rank(a) - rank(b));
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
