import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ContextApiImpl, loadAgentContextCollections, loadEnabledContextCollections } from "../src/context-api.js";
import { accountEnabledCollections } from "../src/library-read.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import { domainName } from "../src/domain.js";
import { MAX_SCOPED_COLLECTIONS_PER_WORKSPACE } from "../src/context-types.js";

const DOMAIN = "scope-domain";
// Public collections are visible to every account in their domain, so the one public case below
// gets a domain of its own rather than leaking into the other tests' enabled sets.
const PUBLIC_DOMAIN = "scope-domain-public";
// Workspace ids are Durable Object ID strings, and the API boundary validates that shape.
const WORKSPACE = "0f".repeat(32);
const OTHER_WORKSPACE = "1a".repeat(32);

function api(accountId: string, isAdmin = false, domain = DOMAIN) {
  return new ContextApiImpl(
    env as unknown as Cloudflare.Env,
    domain,
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

  it("revokes the scope, returning the collection to private", async () => {
    let user = api("user-4");
    let meta = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);

    await user.revokeContextCollectionWorkspace(meta.id);

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

  it("scopes a private collection to a workspace, enabling it only there", async () => {
    let user = api("user-9");
    let meta = await user.createContextCollection("Mine", "Personal notes.", "private");

    await user.setContextCollectionWorkspace(meta.id, WORKSPACE);

    let refreshed = await user.getContextCollectionMetadata(meta.id);
    expect(refreshed?.visibility).toBe("workspace");
    expect(refreshed?.workspaceId).toBe(WORKSPACE);
    expect((await library("user-9").getEnabledCollections(DOMAIN, WORKSPACE)).get(meta.id))
      .toBe("workspace");
    expect((await library("user-9").getEnabledCollections(DOMAIN, OTHER_WORKSPACE)).has(meta.id))
      .toBe(false);
  });

  it("re-scopes a revoked collection back to its workspace, and takes the same scope twice", async () => {
    // The documented remedy for a revoke: a workspace whose new collaborators are blocked because
    // its agent already read this collection gets them back the moment it is shared again.
    let user = api("user-10");
    let meta = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);
    await user.revokeContextCollectionWorkspace(meta.id);
    expect((await library("user-10").getEnabledCollections(DOMAIN, WORKSPACE)).get(meta.id))
      .toBe("private");

    await user.setContextCollectionWorkspace(meta.id, WORKSPACE);

    expect((await user.getContextCollectionMetadata(meta.id))?.workspaceId).toBe(WORKSPACE);
    expect((await library("user-10").getEnabledCollections(DOMAIN, WORKSPACE)).get(meta.id))
      .toBe("workspace");
    // Idempotent: re-sharing with the workspace it already has is a no-op, not an error.
    await expect(user.setContextCollectionWorkspace(meta.id, WORKSPACE)).resolves.toBeUndefined();
    expect((await library("user-10").getEnabledCollections(DOMAIN, WORKSPACE)).get(meta.id))
      .toBe("workspace");
  });

  it("refuses a blank workspace id", async () => {
    let user = api("user-11");
    let meta = await user.createContextCollection("Mine", "Personal notes.", "private");
    await expect(user.setContextCollectionWorkspace(meta.id, "   "))
      .rejects.toThrow(/workspace must be chosen/i);
    expect((await user.getContextCollectionMetadata(meta.id))?.visibility).toBe("private");
  });

  it("refuses a workspace id that is not a Durable Object id", async () => {
    let user = api("user-15");
    let meta = await user.createContextCollection("Mine", "Personal notes.", "private");

    await expect(user.setContextCollectionWorkspace(meta.id, "not-a-workspace"))
      .rejects.toThrow(/not a valid workspace id/i);
    // A 64-character id that isn't hex is rejected too, not just a short one.
    await expect(user.setContextCollectionWorkspace(meta.id, "z".repeat(64)))
      .rejects.toThrow(/not a valid workspace id/i);
    expect((await user.getContextCollectionMetadata(meta.id))?.visibility).toBe("private");

    await expect(user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", "ws-1"))
      .rejects.toThrow(/not a valid workspace id/i);
  });

  it("refuses to scope a public collection, which has no owner library to hold the scope", async () =>{
    let admin = api("admin-1", true, PUBLIC_DOMAIN);
    let meta = await admin.createContextCollection("Handbook", "Company handbook.", "public");

    await expect(admin.setContextCollectionWorkspace(meta.id, WORKSPACE))
      .rejects.toThrow(/shared with everyone/i);
    expect((await admin.getContextCollectionMetadata(meta.id))?.visibility).toBe("public");
  });

  it("refuses to scope a collection the caller does not own", async () => {
    let meta = await api("user-12").createContextCollection("Mine", "Personal notes.", "private");
    await expect(api("stranger").setContextCollectionWorkspace(meta.id, WORKSPACE))
      .rejects.toThrow(/don't have access/);
  });

  it("rejects a scope into a workspace already holding the cap", async () => {
    let user = api("user-13");
    let meta = await user.createContextCollection("Mine", "Personal notes.", "private");
    // Filled through the library directly: this exercises the existing cap on the scope-change path
    // (updateOwnedCollection), not a second check of its own.
    for (let i = 0; i < MAX_SCOPED_COLLECTIONS_PER_WORKSPACE; i++) {
      await library("user-13").createOwnedCollection(`filler-${i}`, `C${i}`, "", undefined, WORKSPACE);
    }

    await expect(user.setContextCollectionWorkspace(meta.id, WORKSPACE))
      .rejects.toThrow(/too many/i);
    expect((await user.getContextCollectionMetadata(meta.id))?.visibility).toBe("private");
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

describe("agent-facing collection listing", () => {
  it("filters scoped collections by workspace, and never filters the management listing", async () => {
    let user = api("user-7");
    let scoped = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);
    let plain = await user.createContextCollection("Mine", "Personal notes.", "private");

    let inScope = await loadAgentContextCollections(
      env as unknown as Cloudflare.Env, DOMAIN, library("user-7"), WORKSPACE);
    expect(inScope.map(entry => entry.id).toSorted()).toEqual([plain.id, scoped.id].toSorted());

    let elsewhere = await loadAgentContextCollections(
      env as unknown as Cloudflare.Env, DOMAIN, library("user-7"), OTHER_WORKSPACE);
    expect(elsewhere.map(entry => entry.id)).toEqual([plain.id]);

    // The management listing is deliberately unfiltered: hiding the creator's own scoped
    // collection from their own library page would be a bug, not exclusivity.
    let managed = await loadEnabledContextCollections(
      env as unknown as Cloudflare.Env, DOMAIN, library("user-7"));
    expect(managed.map(entry => entry.id).toSorted()).toEqual([plain.id, scoped.id].toSorted());
  });

  it("pins a read session to the collections enabled in its workspace", async () => {
    let user = api("user-8");
    let scoped = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);
    await user.putContextDocument(scoped.id, "notes.md", {
      description: "Notes.", body: "# Secret project notes",
    });

    let libraries = env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>;
    let inScope = await accountEnabledCollections(libraries, DOMAIN, "user-8", WORKSPACE)();
    expect(inScope.has(scoped.id)).toBe(true);
    let elsewhere = await accountEnabledCollections(libraries, DOMAIN, "user-8", OTHER_WORKSPACE)();
    expect(elsewhere.has(scoped.id)).toBe(false);
  });
});
