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
