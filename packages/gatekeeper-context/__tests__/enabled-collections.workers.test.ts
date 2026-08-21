import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountEnabledCollections } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import { publicCollectionsKvKey } from "../src/collection-kv.js";
import { domainName } from "../src/domain.js";
import { MAX_SCOPED_COLLECTIONS_PER_WORKSPACE } from "../src/context-types.js";

const DOMAIN = "seam-domain";
const LIBRARIES = env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>;

describe("enabled collection resolution", () => {
  it("resolves the account's own collections plus every public one", async () => {
    let accountId = crypto.randomUUID();
    let library = LIBRARIES.get(LIBRARIES.idFromName(domainName(DOMAIN, accountId)));
    await library.createOwnedCollection("owned-1", "Mine", "Private notes.");

    await env.CONTEXT_COLLECTIONS.put(publicCollectionsKvKey(DOMAIN), JSON.stringify([{
      id: "public-1",
      title: "Sales",
      description: "Sales knowledge.",
      visibility: "public",
      documentCount: 3,
      lastUpdated: new Date().toISOString(),
    }]));

    let enabled = await accountEnabledCollections(LIBRARIES, DOMAIN, accountId)();
    expect(enabled.get("owned-1")).toBe("private");
    expect(enabled.get("public-1")).toBe("public");
  });

  it("hides a scoped collection from other workspaces and from no-workspace callers", async () => {
    let accountId = crypto.randomUUID();
    let library = LIBRARIES.get(LIBRARIES.idFromName(domainName(DOMAIN, accountId)));
    await library.createOwnedCollection("plain", "Mine", "Private notes.");
    await library.createOwnedCollection("scoped", "Project", "Project notes.", undefined, "ws-1");

    let inScope = await library.getEnabledCollections(DOMAIN, "ws-1");
    expect(inScope.get("plain")).toBe("private");
    expect(inScope.get("scoped")).toBe("workspace");

    let otherWorkspace = await library.getEnabledCollections(DOMAIN, "ws-2");
    expect(otherWorkspace.get("plain")).toBe("private");
    expect(otherWorkspace.has("scoped")).toBe(false);

    let noWorkspace = await library.getEnabledCollections(DOMAIN);
    expect(noWorkspace.has("scoped")).toBe(false);
  });

  it("keeps a scope across a metadata refresh", async () => {
    let accountId = crypto.randomUUID();
    let library = LIBRARIES.get(LIBRARIES.idFromName(domainName(DOMAIN, accountId)));
    await library.createOwnedCollection("scoped", "Project", "Project notes.", undefined, "ws-1");

    await library.updateOwnedCollection("scoped", {
      id: "scoped",
      title: "Project renamed",
      description: "Project notes.",
      visibility: "workspace",
      workspaceId: "ws-1",
      documentCount: 2,
      lastUpdated: new Date(),
    });

    expect((await library.getEnabledCollections(DOMAIN, "ws-1")).has("scoped")).toBe(true);
    expect((await library.getEnabledCollections(DOMAIN, "ws-2")).has("scoped")).toBe(false);
    expect((await library.listOwnedCollections())[0].scopedToWorkspace).toBe("ws-1");
  });

  it("clears the scope when a refresh carries no workspace", async () => {
    let accountId = crypto.randomUUID();
    let library = LIBRARIES.get(LIBRARIES.idFromName(domainName(DOMAIN, accountId)));
    await library.createOwnedCollection("scoped", "Project", "Project notes.", undefined, "ws-1");

    await library.updateOwnedCollection("scoped", {
      id: "scoped",
      title: "Project",
      description: "Project notes.",
      visibility: "private",
      documentCount: 0,
      lastUpdated: new Date(),
    });

    expect((await library.getEnabledCollections(DOMAIN)).get("scoped")).toBe("private");
    expect((await library.listOwnedCollections())[0].scopedToWorkspace).toBeUndefined();
  });

  it("caps how many collections one workspace may hold", async () => {
    let accountId = crypto.randomUUID();
    let library = LIBRARIES.get(LIBRARIES.idFromName(domainName(DOMAIN, accountId)));
    for (let i = 0; i < MAX_SCOPED_COLLECTIONS_PER_WORKSPACE; i++) {
      await library.createOwnedCollection(`scoped-${i}`, `C${i}`, "", undefined, "ws-1");
    }
    // A different workspace is unaffected by another's budget.
    await library.createOwnedCollection("other-ws", "Other", "", undefined, "ws-2");

    await expect(library.createOwnedCollection("one-too-many", "No", "", undefined, "ws-1"))
      .rejects.toThrow(/too many/i);
  });
});
