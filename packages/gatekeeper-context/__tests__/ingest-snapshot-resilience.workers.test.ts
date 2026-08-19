// Covers the two operational defects closed after the CI ingestion feature shipped (see
// docs/superpowers/specs/2026-08-07-github-knowledge-layer-design.md):
//
// 1. commitIngest must report "applied" even when the post-commit summary refresh fails -- the
//    content is already durably committed by that point, so a refresh failure must not be able to
//    turn a successful publish into a reported failure.
// 2. The domain's public-collections KV snapshot must not be rewritten by a plain publish (which
//    only changes documentCount/lastUpdated); it must still be rewritten when an identity field
//    (title/description/icon/visibility) changes.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ContextApiImpl } from "../src/context-api.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import { publicCollectionsKvKey } from "../src/collection-kv.js";
import { sha256Hex, type ManifestEntry } from "../src/ingest-manifest.js";
import { domainName } from "../src/domain.js";

const COLLECTIONS = env.CONTEXT_COLLECTIONS_TEST as DurableObjectNamespace<ContextCollectionDurableObject>;
const LIBRARIES = env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>;
const REGISTRIES = env.REGISTRIES_TEST as DurableObjectNamespace<LibraryRegistryDurableObject>;

function api(domain: string, accountId: string, isAdmin: boolean) {
  return new ContextApiImpl(
    env as unknown as Cloudflare.Env,
    domain,
    accountId,
    isAdmin,
    COLLECTIONS,
    LIBRARIES,
    REGISTRIES,
  );
}

function collectionStub(domain: string, id: string) {
  return COLLECTIONS.get(COLLECTIONS.idFromName(domainName(domain, id)));
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

// Publish a whole document set in one plan/upload/commit cycle through the real ingestion protocol.
async function publish(domain: string, collectionId: string, commit: string, files: Record<string, string>) {
  let collection = collectionStub(domain, collectionId);
  let manifest = await Promise.all(
    Object.entries(files).map(([path, body]) => entry(path, body)));
  let plan = await collection.planIngest(commit, manifest, false);
  if (plan.status !== "planned") throw new Error(`expected a planned session, got ${plan.status}`);
  let documents = await Promise.all(
    plan.needed.map(async path => upload(path, files[path], await hashOf(files[path]))));
  if (documents.length > 0) await collection.stageDocuments(plan.sessionId, documents);
  return collection.commitIngest(plan.sessionId, manifest);
}

describe("commitIngest survives a failed summary refresh", () => {
  it("still reports \"applied\" when the post-commit registry sync throws", async () => {
    let domain = `propagate-failure-${crypto.randomUUID()}`;
    let meta = await api(domain, "admin-1", true).createContextCollection(
      "Runbooks", "Published department runbooks.", "public", undefined, "push");

    // Replace the collection's own view of the registry export with a local fake whose syncPublic()
    // rejects in-process. This simulates "the summary refresh failed" without ever letting a real
    // rejection travel across the Durable Object RPC boundary between two real DOs (the test harness
    // double-reports those and can fail the suite) -- the rejection here is a plain local promise,
    // fully contained within the single commitIngest call under test.
    //
    // ctx.exports is a script-wide facade, not per-instance state, so this patch reaches every DO in
    // the isolate and must be undone before this test returns.
    let collection = collectionStub(domain, meta.id);
    let originalExport: unknown;
    await runInDurableObject(collection, (instance) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let anyInstance = instance as any;
      originalExport = anyInstance.ctx.exports.LibraryRegistryDurableObject;
      anyInstance.ctx.exports.LibraryRegistryDurableObject = {
        getByName: () => ({
          syncPublic: () => Promise.reject(new Error("simulated summary-refresh failure")),
        }),
      };
    });

    let outcome: Awaited<ReturnType<typeof publish>>;
    try {
      outcome = await publish(domain, meta.id, "c1", {
        "runbooks/deploy.md": "# Deploy runbook",
      });
    } finally {
      await runInDurableObject(collection, (instance) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (instance as any).ctx.exports.LibraryRegistryDurableObject = originalExport;
      });
    }

    // The publication itself must be reported as successful -- the content is already committed by
    // the time the summary refresh runs, so a refresh failure must not surface as a failed publish.
    expect(outcome).toMatchObject({ status: "applied", added: 1 });
  });
});

describe("public-collections snapshot rewrite is gated on identity fields", () => {
  it("is not rewritten by a publish, but is rewritten by a title change", async () => {
    let domain = `snapshot-gating-${crypto.randomUUID()}`;
    let owner = api(domain, "admin-1", true);
    let meta = await owner.createContextCollection(
      "Runbooks", "Published department runbooks.", "public", undefined, "push");

    let kvKey = publicCollectionsKvKey(domain);
    let rawAfterCreate = await env.CONTEXT_COLLECTIONS.get(kvKey);
    expect(rawAfterCreate).not.toBeNull();

    // A plain publish changes documentCount and lastUpdated -- exactly the fields the fix treats as
    // non-triggering -- so the shared snapshot key must come out byte-for-byte unchanged.
    let outcome = await publish(domain, meta.id, "c1", {
      "runbooks/deploy.md": "# Deploy runbook",
      "runbooks/rollback.md": "# Rollback runbook",
    });
    expect(outcome).toMatchObject({ status: "applied", added: 2 });

    let rawAfterPublish = await env.CONTEXT_COLLECTIONS.get(kvKey);
    expect(rawAfterPublish).toEqual(rawAfterCreate);

    // A title change is an identity field, so it must still trigger the rewrite -- and, because the
    // rewrite recomputes the summary fresh from current metadata, it also catches the snapshot's
    // documentCount up to what the skipped publish above left stale.
    await owner.updateContextCollection(meta.id, { title: "Runbooks (renamed)" });

    let rawAfterRename = await env.CONTEXT_COLLECTIONS.get(kvKey);
    expect(rawAfterRename).not.toEqual(rawAfterPublish);

    let parsed = JSON.parse(rawAfterRename!) as { id: string; title: string; documentCount: number }[];
    let ours = parsed.find(c => c.id === meta.id);
    expect(ours).toMatchObject({ title: "Runbooks (renamed)", documentCount: 2 });
  });
});
