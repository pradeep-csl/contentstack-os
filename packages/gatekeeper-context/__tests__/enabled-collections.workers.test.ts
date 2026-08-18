import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountEnabledCollections, type ResolveEnabledCollections } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import { publicCollectionsKvKey } from "../src/collection-kv.js";
import { domainName } from "../src/domain.js";

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

  it("accepts a resolver pinned to a single collection", async () => {
    // The seam phase 2 needs: a session told exactly which collections it may reach.
    let pinned: ResolveEnabledCollections = async () => new Map([["only-this", "public" as const]]);
    let enabled = await pinned();
    expect([...enabled.keys()]).toEqual(["only-this"]);
  });
});
