import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getServerConfig } from "../src/deployment-config.js";
import type { AdminSettings } from "../src/admin-settings.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  }
}

const ADMIN_USER_ID = "admin@example.com";

/**
 * Runs `body` against a fresh AdminSettings singleton. `updateAdminConfig`/`getSettings` exist
 * directly on the DO (AdminApiImpl is a thin RpcTarget forwarding facade over the same stub calls
 * -- see admin-settings.ts), so exercising the DO here covers the same read/modify/write and KV
 * mirror path setPaused() drives.
 */
async function withAdmin(name: string, body: (admin: AdminSettings) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(name), body);
}

describe("admin settings: paused", () => {
  it("reports paused in the settings view", async () => {
    await withAdmin("paused-view", async (admin) => {
      await admin.updateAdminConfig({ paused: true });

      expect((await admin.getSettings(ADMIN_USER_ID)).paused).toBe(true);
    });
  });

  it("resumes", async () => {
    await withAdmin("paused-resume", async (admin) => {
      await admin.updateAdminConfig({ paused: true });
      await admin.updateAdminConfig({ paused: false });

      expect((await admin.getSettings(ADMIN_USER_ID)).paused).toBe(false);
    });
  });

  // The login page needs it before anyone authenticates. getServerConfig() is built from the KV
  // mirror (readAdminConfig), not the DO's own copy -- that's the property under test, since every
  // enforcement path (sign-in, agent turns, hooks) reads that same mirror.
  it("reports paused in the unauthenticated server config", async () => {
    await withAdmin("paused-server-config", async (admin) => {
      await admin.updateAdminConfig({ paused: true });
    });

    expect((await getServerConfig(env)).paused).toBe(true);
  });

  // Pausing must not disturb unrelated settings.
  it("leaves other settings untouched", async () => {
    await withAdmin("paused-leaves-others", async (admin) => {
      await admin.updateAdminConfig({ siteName: "Acme" });
      await admin.updateAdminConfig({ paused: true });

      expect((await admin.getSettings(ADMIN_USER_ID)).siteName).toBe("Acme");
    });
  });
});
