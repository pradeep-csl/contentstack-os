// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody, AiToolCall } from "@gadgets/workshop-shared/api";
import { buildChatDisplayEntries, isRailEntry } from "./ChatInterface";

const AGENT = { type: "agent", id: "test-model", name: "Test" } as const;
const USER = { type: "user", id: "u1", name: "Someone" } as const;

function message(
  sequence: number,
  author: typeof AGENT | typeof USER,
  body: AiChatMessageBody,
): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author, ...body };
}

function executeCode(toolCallId: string): AiToolCall {
  return { toolCallId, toolName: "executeCode", input: { code: "self.x()" } } as AiToolCall;
}

/** Which display entries the rail runs through, in order. */
function railShape(messages: AiChatMessage[]): boolean[] {
  return buildChatDisplayEntries(messages, new Map()).map(isRailEntry);
}

describe("isRailEntry", () => {
  it("runs the rail through every entry of one agent turn", () => {
    // A turn is split up: the tool calls land in their own entry, the prose in another. Both have
    // to be on the rail or a turn reads as several disconnected fragments.
    const shape = railShape([
      message(1, USER, { type: "message", message: "how does this work?" }),
      message(2, AGENT, { type: "message", message: "", toolCalls: [executeCode("a")] }),
      message(3, AGENT, { type: "message", message: "Here is the answer.", reasoning: "hm" }),
    ]);
    expect(shape).toEqual([false, true, true]);
  });

  it("keeps the user's own message off the rail, so the rail can't span two turns", () => {
    const shape = railShape([
      message(1, AGENT, { type: "message", message: "First answer." }),
      message(2, USER, { type: "message", message: "follow-up" }),
      message(3, AGENT, { type: "message", message: "Second answer." }),
    ]);
    expect(shape).toEqual([true, false, true]);
  });

  it("puts a lone agent answer on the rail", () => {
    expect(railShape([message(1, AGENT, { type: "message", message: "Just prose." })])).toEqual([
      true,
    ]);
  });
});
