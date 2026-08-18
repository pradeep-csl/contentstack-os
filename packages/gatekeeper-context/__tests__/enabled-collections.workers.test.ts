import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountEnabledCollections } from "../src/library-read.js";
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
});
