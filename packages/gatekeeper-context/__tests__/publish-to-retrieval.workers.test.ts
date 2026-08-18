// Proves the join that every other test in this package leaves untested: content published through
// the real CI ingestion protocol (planIngest/stageDocuments/commitIngest) becomes visible to a
// *different* account's agent read session, end to end through the registry + KV snapshot. A break
// anywhere along that chain is silent -- no error, agents simply stop finding things -- so this test
// drives the real protocol rather than poking storage directly.

import { env } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ObservationAuthorizer, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { ContextApiImpl } from "../src/context-api.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import { accountEnabledCollections, LibraryReadSession } from "../src/library-read.js";
import { sha256Hex, type ManifestEntry } from "../src/ingest-manifest.js";
import { domainName } from "../src/domain.js";

const DOMAIN = "publish-to-retrieval-domain";

const COLLECTIONS = env.CONTEXT_COLLECTIONS_TEST as DurableObjectNamespace<ContextCollectionDurableObject>;
const LIBRARIES = env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>;
const REGISTRIES = env.REGISTRIES_TEST as DurableObjectNamespace<LibraryRegistryDurableObject>;

function api(accountId: string, isAdmin: boolean) {
  return new ContextApiImpl(
    env as unknown as Cloudflare.Env,
    DOMAIN,
    accountId,
    isAdmin,
    COLLECTIONS,
    LIBRARIES,
    REGISTRIES,
  );
}

// Address the DO exactly as production does, so the test cannot drift from the real naming.
function collectionStub(id: string) {
  return COLLECTIONS.get(COLLECTIONS.idFromName(domainName(DOMAIN, id)));
}

async function hashOf(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

async function entry(path: string, body: string): Promise<ManifestEntry> {
  return { path, hash: await hashOf(body) };
}

function upload(path: string, body: string, hash: string) {
  return {
    path, name: path, description: "", contentType: "text/markdown", body, hash,
    lastUpdated: new Date(),
  };
}

// Publish a whole document set in one plan/upload/commit cycle through the real ingestion protocol
// (mirrors the working helper in collection-ingest.workers.test.ts).
async function publish(collectionId: string, commit: string, files: Record<string, string>) {
  let collection = collectionStub(collectionId);
  let manifest = await Promise.all(
    Object.entries(files).map(([path, body]) => entry(path, body)));
  let plan = await collection.planIngest(commit, manifest, false);
  if (plan.status !== "planned") throw new Error(`expected a planned session, got ${plan.status}`);
  let documents = await Promise.all(
    plan.needed.map(async path => upload(path, files[path], await hashOf(files[path]))));
  if (documents.length > 0) await collection.stageDocuments(plan.sessionId, documents);
  return collection.commitIngest(plan.sessionId, manifest);
}

// A genuine `cloudflare:workers` RpcStub wrapping a real RpcTarget, rather than a hand-rolled object
// cast with `as unknown as`: LibraryReadSession's authorizer parameter is used as a real stub (it is
// dup()'d in production, and disposed via Symbol.dispose here through `using`), and both of those
// come for free from the Stub wrapper -- they don't need to exist on the target class at all.
class NoopAuthorizer extends RpcTarget implements ObservationAuthorizer {
  async authorizeObservation(_description: ObservationDescription): Promise<void> {}
}

function noopObserveCollections() {
  return Promise.resolve({ pendingCollections: [] as string[], commit() {} });
}

describe("publish to retrieval", () => {
  it("makes content published by one account searchable and readable by a different account", async () => {
    let publisherId = crypto.randomUUID();
    let readerId = crypto.randomUUID(); // Owns nothing -- that is the whole point of this test.

    // 1. Create a public push collection through the real API, not initialize() directly. This is
    // what registers the collection with LibraryRegistryDurableObject and writes the domain's KV
    // snapshot -- the first link in the chain this test exists to catch a break in.
    let meta = await api(publisherId, true).createContextCollection(
      "Runbooks", "Published department runbooks.", "public", undefined, "push");
    expect(meta.visibility).toBe("public");

    // 2. Mint an ingestion token and publish through the real plan/stage/commit protocol. The token
    // itself is not an argument to planIngest/stageDocuments/commitIngest -- production authenticates
    // it at the HTTP layer (ingest-handler.ts) before addressing the collection by id, exactly as
    // collectionStub() does here -- so prove it is real against that same verification surface.
    let token = await api(publisherId, true).createContextCollectionIngestToken(meta.id);
    expect(token.plaintext).toMatch(/^[0-9a-f]{32}$/);
    expect(await collectionStub(meta.id).verifyIngestToken(token.plaintext)).toBe(true);

    let outcome = await publish(meta.id, "c1", {
      "runbooks/deploy.md":
        "# Deploy runbook\n\nThe quokka-relocation-protocol covers safe rollout steps.",
      "runbooks/rollback.md": "# Rollback runbook\n\nHow to revert a bad release.",
    });
    expect(outcome).toMatchObject({ status: "applied", added: 2 });

    // 3. The silent link: a *different* account that owns nothing must still resolve the collection
    // as enabled ("public"), because "readable by every agent user" is the actual claim. If the
    // registry ever failed to write its KV snapshot, or getEnabledCollections() failed to read it,
    // this would still pass for the publisher's own account (which owns the private half of nothing
    // here) but silently fail for everyone else -- which is exactly what must not happen.
    let enabled = await accountEnabledCollections(LIBRARIES, DOMAIN, readerId)();
    expect(enabled.get(meta.id)).toBe("public");

    // 4. Drive the real LibraryReadSession end to end: search finds a distinctive phrase from a
    // published document, and reading the returned docId returns its body.
    using session = new LibraryReadSession(
      COLLECTIONS,
      accountEnabledCollections(LIBRARIES, DOMAIN, readerId),
      DOMAIN,
      new RpcStub(new NoopAuthorizer()),
      noopObserveCollections,
    );

    let hits = await session.search("quokka-relocation-protocol");
    let hit = hits.find(h => h.path === "runbooks/deploy.md");
    expect(hit).toBeDefined();
    expect(hit?.collectionId).toBe(meta.id);

    let read = await session.read(hit!.docId);
    expect(read?.content).toContain("quokka-relocation-protocol");
  });
});
