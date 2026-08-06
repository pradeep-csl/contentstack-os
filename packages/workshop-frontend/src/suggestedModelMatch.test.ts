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
