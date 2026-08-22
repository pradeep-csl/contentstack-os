// Test-only entrypoint exposing the Durable Objects to the Workers test pool, and re-exporting the
// real default export so SELF.fetch() in tests drives the production entrypoint (rate limiter,
// ctx.exports resolution, ingestion routing) rather than a stub.

import { DurableObject } from "cloudflare:workers";
import { loadAgentContextCollections } from "../src/context-api.js";
import { domainName } from "../src/domain.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";

export { ContextCollectionDurableObject } from "../src/context-collection.js";
export { UserLibraryDurableObject } from "../src/user-library.js";
export { LibraryRegistryDurableObject } from "../src/registry-do.js";
export { default } from "../src/index.js";

type TestExports = {
  UserLibraryDurableObject: DurableObjectNamespace<UserLibraryDurableObject>;
  ContextScopeTestFacet: DurableObjectClass<ContextScopeTestFacet>;
};

/** Test-only parent used to exercise Context scoping with real workerd facets. */
export class ContextScopeTestParent extends DurableObject<Cloudflare.Env> {
  /** Catalogs one account through the inherited scope of a named Context facet. */
  async catalogThroughFacet(
      facetName: string, sharingDomain: string, accountId: string): Promise<string[]> {
    const exports = this.ctx.exports as unknown as TestExports;
    const facet = this.ctx.facets.get<ContextScopeTestFacet>(facetName, () => ({
      class: exports.ContextScopeTestFacet,
    }));
    return facet.catalogForAccount(sharingDomain, accountId);
  }
}

/** Test-only facet that applies Context's account-library and inherited-workspace scoping. */
export class ContextScopeTestFacet extends DurableObject<Cloudflare.Env> {
  /** Titles the shared account's collections through this facet's inherited parent ID. */
  async catalogForAccount(sharingDomain: string, accountId: string): Promise<string[]> {
    const libraries = (this.ctx.exports as unknown as TestExports).UserLibraryDurableObject;
    const userLibrary = libraries.get(libraries.idFromName(domainName(sharingDomain, accountId)));
    const collections = await loadAgentContextCollections(
      this.env, sharingDomain, userLibrary, this.ctx.id.toString());
    return collections.map(collection => collection.title);
  }
}
