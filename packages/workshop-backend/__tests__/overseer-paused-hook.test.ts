import { describe, expect, it, vi } from "vitest";
import { HOOK_PAUSED_MESSAGE } from "@gadgets/workshop-shared/gatekeeper";
import { DEFAULT_ADMIN_CONFIG, serializeAdminConfig } from "../src/admin-config.js";
import { OverseerDurableObject } from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

function makeOverseer(getConfig: () => Promise<string | null>): OverseerDurableObject {
  let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
  Object.assign(overseer, {
    env: { BLUEPRINTS: { get: getConfig } },
    impl: {
      storage: {
        boundHooks: { get: () => ({ enabled: true, vendorId: "email", callback: {}, gatekeeperId: 1 }) },
        gatekeepers: { get: () => undefined },
      },
    },
  });
  return overseer;
}

function startHookUnderTest(paused: boolean) {
  let overseer = makeOverseer(
      async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, paused }));
  return overseer.startHook(1);
}

describe("OverseerDurableObject.startHook while paused", () => {
  it("refuses to start a hook while the deployment is paused", async () => {
    await expect(startHookUnderTest(true)).rejects.toThrow(HOOK_PAUSED_MESSAGE);
  });

  it("starts hooks normally when not paused", async () => {
    await expect(startHookUnderTest(false)).resolves.toBeDefined();
  });

  // The paused check must precede capability construction: a returned ApprovalQueue is a live
  // session the gatekeeper could still use.
  it("returns no capability while paused", async () => {
    let result = await startHookUnderTest(true).catch(() => undefined);
    expect(result).toBeUndefined();
  });
});
