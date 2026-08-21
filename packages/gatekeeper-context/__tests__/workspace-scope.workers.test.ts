import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ContextApiImpl } from "../src/context-api.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import { domainName } from "../src/domain.js";

const DOMAIN = "scope-domain";
const WORKSPACE = "w".repeat(64);
const OTHER_WORKSPACE = "x".repeat(64);

function api(accountId: string, isAdmin = false) {
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

function library(accountId: string) {
  let libraries = env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>;
  return libraries.get(libraries.idFromName(domainName(DOMAIN, accountId)));
}

describe("workspace-scoped collections", () => {
  it("needs a workspace id, and refuses one for other visibilities", async () => {
    await expect(api("user-1").createContextCollection("P", "Project notes.", "workspace"))
      .rejects.toThrow(/workspace/i);
    await expect(
      api("user-1").createContextCollection("P", "Project notes.", "private", undefined, "web", WORKSPACE),
    ).rejects.toThrow(/only workspace-scoped/i);
  });

  it("creates one for a non-admin, owned by its creator", async () => {
    let user = api("user-2");
    let meta = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);

    expect(meta.visibility).toBe("workspace");
    expect(meta.workspaceId).toBe(WORKSPACE);
    // Owned, so the creator can still write to it.
    expect(await user.canWriteContextCollection(meta.id)).toBe(true);
    await user.putContextDocument(meta.id, "notes.md", { description: "Notes.", body: "# Notes" });
    expect((await user.listContextDocuments(meta.id))).toHaveLength(1);
  });

  it("is enabled only in its own workspace", async () => {
    let meta = await api("user-3").createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);

    expect((await library("user-3").getEnabledCollections(DOMAIN, WORKSPACE)).get(meta.id))
      .toBe("workspace");
    expect((await library("user-3").getEnabledCollections(DOMAIN, OTHER_WORKSPACE)).has(meta.id))
      .toBe(false);
  });

  it("reports and revokes the scope, returning the collection to private", async () => {
    let user = api("user-4");
    let meta = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);
    expect(await user.getContextCollectionWorkspace(meta.id)).toBe(WORKSPACE);

    await user.revokeContextCollectionWorkspace(meta.id);

    expect(await user.getContextCollectionWorkspace(meta.id)).toBeNull();
    let refreshed = await user.getContextCollectionMetadata(meta.id);
    expect(refreshed?.visibility).toBe("private");
    expect(refreshed?.workspaceId).toBeUndefined();
    // Private again means enabled everywhere, including with no workspace context.
    expect((await library("user-4").getEnabledCollections(DOMAIN)).get(meta.id)).toBe("private");
  });

  it("refuses to revoke a collection the caller does not own", async () => {
    let meta = await api("user-5").createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);
    await expect(api("stranger").revokeContextCollectionWorkspace(meta.id))
      .rejects.toThrow(/don't have access/);
  });

  it("keeps the management listing showing the creator's scoped collections", async () => {
    let user = api("user-6");
    let meta = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);

    let listed = await user.listEnabledContextCollections();
    let entry = listed.find(collection => collection.id === meta.id);
    expect(entry?.workspaceId).toBe(WORKSPACE);
    // Never widened: the management UI's sort comparator depends on `source` being two-valued.
    expect(entry?.source).toBe("private");
  });
});
