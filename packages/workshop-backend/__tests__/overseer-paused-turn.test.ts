import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { keyString } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo, AiChatMetadata, AiChatMessage, AiModelConfig } from "@gadgets/workshop-shared/api";
import { DEFAULT_ADMIN_CONFIG } from "../src/admin-config.js";
import type { UserAiModelRecord } from "../src/user.js";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// #runAgentTurnWithContext's paused gate must run before runAgent is ever invoked -- a paused
// deployment spends nothing. Stubbing runAgent (rather than letting it reach a real provider) is
// what lets "runs normally once resumed" assert a call happened without any network I/O.
const runAgentMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent.js")>();
  return { ...actual, runAgent: runAgentMock };
});

// Stubbing readAdminConfig avoids needing a KV binding just to flip one flag.
const readAdminConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../src/admin-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/admin-config.js")>();
  return { ...actual, readAdminConfig: readAdminConfigMock };
});

const AUTHOR: AiChatAuthorInfo = { type: "agent", id: "model-id", name: "Model" };
const AI_MODEL: UserAiModelRecord = {
  profile: AUTHOR,
  config: { provider: "anthropic", model: "test-model", apiToken: "test-token" } satisfies AiModelConfig,
};

/** The subset of OverseerImpl this suite drives and inspects directly. */
type ImplHandle = {
  storage: {
    chatMeta: { put(meta: AiChatMetadata): void };
    activeAgents: { get(chatId: number): unknown };
    chats: { list(opts?: { prefix?: string }): Iterable<AiChatMessage> };
  };
  startAgent(
      chatId: number, aiModel: UserAiModelRecord, initiator: AiChatAuthorInfo,
      initiatorUserId: string, callbackInitiated?: boolean, keepAlive?: boolean): void;
};

function implOf(instance: OverseerDurableObject): ImplHandle {
  return (instance as unknown as { impl: ImplHandle }).impl;
}

/**
 * Seeds a fresh chat, starts an agent turn against it, and waits for the turn to finish (observed
 * as the persistent `activeAgents` record -- written synchronously by `startAgent`, deleted by the
 * turn's `finally` -- going away). `afterTurn` runs while still inside `runInDurableObject`: storage
 * I/O is scoped to the Durable Object it was opened under and cannot be touched afterward.
 */
async function runTurn(
    paused: boolean,
    options: { callbackInitiated?: boolean; afterTurn?: (impl: ImplHandle) => void } = {}): Promise<void> {
  readAdminConfigMock.mockResolvedValue({ ...DEFAULT_ADMIN_CONFIG, paused });

  const chatId = 1;
  const stub = env.TEST_OVERSEER.getByName(`paused-turn-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = implOf(instance);
    impl.storage.chatMeta.put({
      id: chatId, title: "Chat", started: new Date(0), lastActive: new Date(0),
    });

    impl.startAgent(
        chatId, AI_MODEL, AUTHOR, "initiator-id", options.callbackInitiated ?? false);

    await vi.waitFor(() => {
      expect(impl.storage.activeAgents.get(chatId)).toBeUndefined();
    }, { timeout: 3000 });

    options.afterTurn?.(impl);
  });
}

describe("agent turns while the deployment is paused", () => {
  beforeEach(() => {
    runAgentMock.mockClear();
  });

  it("does not start a turn while paused", async () => {
    await runTurn(true);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  // Must not leave the UI spinning: the existing `finally` clears the active-agent state even on
  // this early return, and the caller sees a chat message explaining why nothing happened.
  it("posts an error message and clears the active agent", async () => {
    await runTurn(true, {
      afterTurn: (impl) => {
        const messages = [...impl.storage.chats.list({ prefix: `${keyString(1)}.` })];
        expect(messages.at(-1)).toMatchObject({ type: "error", code: "paused" });
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
      },
    });
  });

  // Pause exists to stop spend; a continuation is spend. Unlike the free-tier usage limit, this
  // gate must not exempt callback-initiated turns.
  it("blocks callback-initiated continuations too", async () => {
    await runTurn(true, { callbackInitiated: true });
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("runs normally once resumed", async () => {
    await runTurn(false);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });
});
