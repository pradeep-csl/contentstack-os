import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// No CF_AI_GATEWAY / OPENROUTER_API_KEY in the test env, so every case here runs in the
// no-gateway mode where the deployment holds no credential of its own and the quick model can
// only come from something the user configured.

function config(model: string): AiModelConfig {
  return { provider: "anthropic", model, apiToken: `token-for-${model}` };
}

async function withUser(
    name: string, body: (user: UserDurableObject) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_USER.getByName(name), body);
}

async function addModel(user: UserDurableObject, id: string): Promise<void> {
  await user.addModel({ type: "agent", id, name: id }, config(id));
}

describe("quick model resolution without a gateway", () => {
  it("falls back to the model resolved for this request", async () => {
    // The case that makes auto-titling work out of the box: newChat() passes the chosen model,
    // so a user who never visited the Providers page still gets titled chats.
    await withUser("fallback-resolved", async (user) => {
      await addModel(user, "claude-sonnet-5");
      const context = await user.getChatContext("claude-sonnet-5");
      expect(context.quickModel).toEqual(config("claude-sonnet-5"));
    });
  });

  it("prefers an explicitly chosen quick model over the request's model", async () => {
    await withUser("explicit-wins", async (user) => {
      await addModel(user, "claude-opus-5");
      await addModel(user, "claude-haiku-4-5");
      await user.setQuickModel("claude-haiku-4-5");

      const context = await user.getChatContext("claude-opus-5");
      expect(context.quickModel).toEqual(config("claude-haiku-4-5"));
      expect(context.aiModel?.config).toEqual(config("claude-opus-5"));
    });
  });

  it("falls back to the preferred model when the request resolves none", async () => {
    // Paths like mergeChanges() call getChatContext(null); without this the gadget title would
    // still never be generated.
    await withUser("fallback-preferred", async (user) => {
      await addModel(user, "claude-opus-5");
      await addModel(user, "claude-sonnet-5");
      await user.setPreferredModel("claude-sonnet-5");

      const context = await user.getChatContext(null);
      expect(context.aiModel).toBeUndefined();
      expect(context.quickModel).toEqual(config("claude-sonnet-5"));
    });
  });

  it("falls back to a configured model when nothing else is set", async () => {
    await withUser("fallback-any", async (user) => {
      await addModel(user, "claude-sonnet-5");
      const context = await user.getChatContext(null);
      expect(context.quickModel).toEqual(config("claude-sonnet-5"));
    });
  });

  it("stays unset when the user has configured no models at all", async () => {
    // Quick tasks are skipped rather than failing: generateThreadTitle() is never called.
    await withUser("no-models", async (user) => {
      const context = await user.getChatContext(null);
      expect(context.quickModel).toBeUndefined();
    });
  });

  it("ignores a stale quick model id and still falls back", async () => {
    // setQuickModel() does not validate, and deleteModel() does not clear it, so the stored id
    // can outlive the model it names.
    await withUser("stale-quick-id", async (user) => {
      await addModel(user, "claude-sonnet-5");
      await user.setQuickModel("deleted-model");

      const context = await user.getChatContext("claude-sonnet-5");
      expect(context.quickModel).toEqual(config("claude-sonnet-5"));
    });
  });
});
