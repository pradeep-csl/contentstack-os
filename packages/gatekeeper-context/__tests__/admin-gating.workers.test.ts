import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ContextApiImpl } from "../src/context-api.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";

const DOMAIN = "test-domain";

function api(accountId: string, isAdmin: boolean) {
  return new ContextApiImpl(
    env as unknown as Cloudflare.Env,
    DOMAIN,
    accountId,
    isAdmin,
    env.CONTEXT_COLLECTIONS_TEST as DurableObjectNamespace<ContextCollectionDurableObject>,
    env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>,
    env.REGISTRIES_TEST as DurableObjectNamespace<LibraryRegistryDurableObject>,
  );
}

describe("admin gating for global collections", () => {
  it("refuses to create a public collection for a non-admin", async () => {
    await expect(
      api("user-1", false).createContextCollection("Sales", "Sales knowledge.", "public", undefined, "push"),
    ).rejects.toThrow(/Admin access required/);
  });

  it("lets an admin create a public push collection with no Artifacts binding", async () => {
    let meta = await api("admin-1", true)
      .createContextCollection("Sales", "Sales knowledge.", "public", undefined, "push");
    expect(meta.visibility).toBe("public");
    expect(meta.content).toEqual({ source: "push" });
  });

  it("refuses to mint an ingestion token on a public collection for a non-admin", async () => {
    let meta = await api("admin-1", true)
      .createContextCollection("Eng", "Engineering knowledge.", "public", undefined, "push");
    await expect(api("user-1", false).createContextCollectionIngestToken(meta.id))
      .rejects.toThrow(/don't have access/);
  });

  it("lets an admin mint, list and revoke a token on a public collection", async () => {
    let admin = api("admin-1", true);
    let meta = await admin.createContextCollection("Ops", "Ops knowledge.", "public", undefined, "push");

    let token = await admin.createContextCollectionIngestToken(meta.id);
    expect(token.path).toBe(`/gatekeeper/context/ingest/${encodeURIComponent(DOMAIN)}/${meta.id}`);
    expect((await admin.listContextCollectionIngestTokens(meta.id)).tokens).toHaveLength(1);
    expect(await admin.revokeContextCollectionIngestToken(meta.id, token.id)).toBe(true);
  });

  it("still lets a non-admin own a private push collection and its token", async () => {
    // Deliberate: the admin gate is on public visibility, not on the push source, so phase 2's
    // workspace-scoped collections can use the same pipeline without reopening this decision.
    let user = api("user-2", false);
    let meta = await user.createContextCollection("Mine", "Personal notes.", "private", undefined, "push");
    let token = await user.createContextCollectionIngestToken(meta.id);
    expect(token.plaintext).toMatch(/^[0-9a-f]{32}$/);
  });
});
