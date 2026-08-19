import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_WORKSPACE_TITLE } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

async function withUser(
    name: string, body: (user: UserDurableObject) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_USER.getByName(name), body);
}

// `lastActive` is the provisional bit (see isFullyCreated): Home's speculative workspace must stay
// out of the user's lists, while a workspace the user asked for by name must appear at once.
describe("workspace visibility at registration", () => {
  it("hides a workspace registered with no last-active time", async () => {
    await withUser("visibility-provisional", async (user) => {
      await user.newGadget("ws-provisional", DEFAULT_WORKSPACE_TITLE);
      expect(await user.listGadgets()).toEqual([]);
    });
  });

  it("lists a workspace registered with a last-active time", async () => {
    await withUser("visibility-explicit", async (user) => {
      await user.newGadget("ws-explicit", "GTM Q3", new Date());

      const listed = await user.listGadgets();
      expect(listed.map((g) => g.id)).toEqual(["ws-explicit"]);
      expect(listed[0]!.title).toBe("GTM Q3");
    });
  });

  // The sidebar's Favorites/Recent sort calls lastActive.getTime() with no null check, so a record
  // that survives storage as anything but a Date would break rendering rather than just sorting.
  it("round-trips last-active through storage as a Date", async () => {
    await withUser("visibility-date", async (user) => {
      await user.newGadget("ws-date", "GTM Q3", new Date());

      const listed = await user.listGadgets();
      expect(listed[0]!.lastActive).toBeInstanceOf(Date);
      expect(Number.isNaN(listed[0]!.lastActive.getTime())).toBe(false);
    });
  });

  it("leaves an explicitly registered workspace visible alongside a provisional one", async () => {
    await withUser("visibility-mixed", async (user) => {
      await user.newGadget("ws-hidden", DEFAULT_WORKSPACE_TITLE);
      await user.newGadget("ws-shown", "GTM Q3", new Date());

      const listed = await user.listGadgets();
      expect(listed.map((g) => g.id)).toEqual(["ws-shown"]);
    });
  });
});
