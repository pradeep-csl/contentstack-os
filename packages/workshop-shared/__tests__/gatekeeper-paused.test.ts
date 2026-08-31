import { describe, expect, it } from "vitest";
import { HOOK_PAUSED_MESSAGE, isHookPausedError } from "../src/gatekeeper.js";

describe("isHookPausedError", () => {
  it("recognises an Error carrying the shared message", () => {
    expect(isHookPausedError(new Error(HOOK_PAUSED_MESSAGE))).toBe(true);
  });

  // Worker RPC may deliver the failure as a plain object or a bare string rather than an Error.
  it("recognises the message on a non-Error value", () => {
    expect(isHookPausedError({ message: HOOK_PAUSED_MESSAGE })).toBe(true);
    expect(isHookPausedError(HOOK_PAUSED_MESSAGE)).toBe(true);
  });

  // RPC frequently prefixes the remote message. Substring matching keeps the signal alive.
  it("recognises a wrapped message", () => {
    expect(isHookPausedError(new Error(`remote error: ${HOOK_PAUSED_MESSAGE}`))).toBe(true);
  });

  // Everything else must keep today's settle-the-schedule behaviour.
  it("rejects unrelated failures", () => {
    expect(isHookPausedError(new Error("Hook has been deleted or disabled."))).toBe(false);
    expect(isHookPausedError(new Error("Gatekeeper is disabled."))).toBe(false);
    expect(isHookPausedError(undefined)).toBe(false);
    expect(isHookPausedError(null)).toBe(false);
  });
});
