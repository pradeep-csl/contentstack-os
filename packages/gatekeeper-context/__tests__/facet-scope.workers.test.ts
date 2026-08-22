// The whole workspace tier rests on one platform behavior: a gatekeeper facet inherits its parent
// Overseer's Durable Object id, so ContextGatekeeper's `this.ctx.id.toString()` *is* the workspace
// id (see library-gatekeeper.ts #workspaceId). Repoint that id — overseer.ts's getGatekeeperFacet
// deliberately passes no explicit `id`, unlike getGadgetFacet — and every scoped collection quietly
// vanishes from its workspace with nothing failing anywhere. This is the tripwire for that, mirroring
// gatekeeper-scheduler's __tests__/scheduler-scope.test.ts.
//
// The facet is the test-only ContextScopeTestFacet (see worker.ts), which resolves the enabled set
// with the production helper and the very expression ContextGatekeeper uses; the test pool cannot
// props-bind a ctx.exports Durable Object class the way ContextAccount does, so the real class
// cannot be opened as a facet here.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ContextApiImpl } from "../src/context-api.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import type { ContextScopeTestParent } from "./worker.js";

const DOMAIN = "facet-scope-domain";
const ACCOUNT = "facet-scope-account";

const testEnv = env as unknown as {
  CONTEXT_SCOPE_TEST_PARENT: DurableObjectNamespace<ContextScopeTestParent>;
};

function api() {
  return new ContextApiImpl(
    env as unknown as Cloudflare.Env,
    DOMAIN,
    ACCOUNT,
    false,
    env.CONTEXT_COLLECTIONS_TEST as DurableObjectNamespace<ContextCollectionDurableObject>,
    env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>,
    env.REGISTRIES_TEST as DurableObjectNamespace<LibraryRegistryDurableObject>,
  );
}

describe("ContextGatekeeper facet scope", () => {
  it("isolates parent IDs while sibling facet names inherit the same parent scope", async () => {
    const parentAId = testEnv.CONTEXT_SCOPE_TEST_PARENT.idFromName("parent-a");
    const parentBId = testEnv.CONTEXT_SCOPE_TEST_PARENT.idFromName("parent-b");
    const parentA = testEnv.CONTEXT_SCOPE_TEST_PARENT.get(parentAId);
    const parentB = testEnv.CONTEXT_SCOPE_TEST_PARENT.get(parentBId);

    // One account owning a collection scoped to each parent: what the facet catalogs is therefore
    // decided entirely by the id it inherited.
    for (const [title, workspaceId] of [
      ["Parent A project", parentAId.toString()],
      ["Parent B project", parentBId.toString()],
    ] as const) {
      await api().createContextCollection(
        title, "Test inherited facet scope.", "workspace", undefined, "web", workspaceId);
    }

    // Sibling facet names under one parent see the same workspace, since neither names an id.
    for (const facetName of ["gatekeeper1", "gatekeeper2"]) {
      await expect(parentA.catalogThroughFacet(facetName, DOMAIN, ACCOUNT))
        .resolves.toEqual(["Parent A project"]);
    }
    await expect(parentB.catalogThroughFacet("gatekeeper1", DOMAIN, ACCOUNT))
      .resolves.toEqual(["Parent B project"]);
  });
});
