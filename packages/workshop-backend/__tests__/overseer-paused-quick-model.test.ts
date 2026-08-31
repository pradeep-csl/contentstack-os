import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, AiChatMetadata, AiModelConfig } from "@gadgets/workshop-shared/api";
import { DEFAULT_ADMIN_CONFIG } from "../src/admin-config.js";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// generateThreadTitle and generateBindingName are one-shot LLM calls that sit outside the
// agent-turn gate (#runAgentTurnWithContext) -- they must independently refuse to spend while
// paused. Stubbing completeText (rather than reaching a real provider) is what lets "once
// resumed" assert a call happened without any network I/O.
const completeTextMock = vi.hoisted(() => vi.fn(async () => "a generated result"));
vi.mock("../src/ai-invoke.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai-invoke.js")>();
  return { ...actual, completeText: completeTextMock };
});

// Stubbing readAdminConfig avoids needing a KV binding just to flip one flag.
const readAdminConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../src/admin-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/admin-config.js")>();
  return { ...actual, readAdminConfig: readAdminConfigMock };
});

const AUTHOR: AiChatAuthorInfo = { type: "agent", id: "model-id", name: "Model" };
const MODEL_CONFIG: AiModelConfig = { provider: "anthropic", model: "test-model", apiToken: "test-token" };

/** The subset of OverseerImpl this suite drives and inspects directly. */
type ImplHandle = {
  storage: {
    chatMeta: { put(meta: AiChatMetadata): void; get(chatId: number): AiChatMetadata | undefined };
  };
  generateThreadTitle(
      chatId: number, initialMessage: string, modelConfig: AiModelConfig,
      initiator: AiChatAuthorInfo): Promise<void>;
  generateBindingName(
      subject: string, takenNames: Set<string>,
      quick: { config: AiModelConfig; initiator: AiChatAuthorInfo }): Promise<string | undefined>;
};

function implOf(instance: OverseerDurableObject): ImplHandle {
  return (instance as unknown as { impl: ImplHandle }).impl;
}

describe("quick-model one-shots while the deployment is paused", () => {
  beforeEach(() => {
    completeTextMock.mockClear();
  });

  it("generateThreadTitle makes no model call while paused", async () => {
    readAdminConfigMock.mockResolvedValue({ ...DEFAULT_ADMIN_CONFIG, paused: true });
    const chatId = 1;
    const stub = env.TEST_OVERSEER.getByName(`paused-title-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = implOf(instance);
      impl.storage.chatMeta.put({
        id: chatId, title: "Chat", started: new Date(0), lastActive: new Date(0),
      });

      await impl.generateThreadTitle(chatId, "hello", MODEL_CONFIG, AUTHOR);

      expect(completeTextMock).not.toHaveBeenCalled();
      // Graceful fallback: the title just stays whatever it was.
      expect(impl.storage.chatMeta.get(chatId)?.title).toBe("Chat");
    });
  });

  it("generateThreadTitle calls the model once resumed", async () => {
    readAdminConfigMock.mockResolvedValue({ ...DEFAULT_ADMIN_CONFIG, paused: false });
    const chatId = 1;
    const stub = env.TEST_OVERSEER.getByName(`resumed-title-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = implOf(instance);
      impl.storage.chatMeta.put({
        id: chatId, title: "Chat", started: new Date(0), lastActive: new Date(0),
      });

      await impl.generateThreadTitle(chatId, "hello", MODEL_CONFIG, AUTHOR);

      expect(completeTextMock).toHaveBeenCalledTimes(1);
    });
  });

  it("generateBindingName makes no model call while paused", async () => {
    readAdminConfigMock.mockResolvedValue({ ...DEFAULT_ADMIN_CONFIG, paused: true });
    const stub = env.TEST_OVERSEER.getByName(`paused-binding-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = implOf(instance);

      const name = await impl.generateBindingName("A quarterly plan", new Set(), {
        config: MODEL_CONFIG, initiator: AUTHOR,
      });

      expect(completeTextMock).not.toHaveBeenCalled();
      // Graceful fallback: same as any other failure to generate a name.
      expect(name).toBeUndefined();
    });
  });

  it("generateBindingName calls the model once resumed", async () => {
    readAdminConfigMock.mockResolvedValue({ ...DEFAULT_ADMIN_CONFIG, paused: false });
    const stub = env.TEST_OVERSEER.getByName(`resumed-binding-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = implOf(instance);

      await impl.generateBindingName("A quarterly plan", new Set(), {
        config: MODEL_CONFIG, initiator: AUTHOR,
      });

      expect(completeTextMock).toHaveBeenCalledTimes(1);
    });
  });
});
