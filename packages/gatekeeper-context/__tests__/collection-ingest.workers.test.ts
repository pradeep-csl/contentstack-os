import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { ContextCollectionMetadata } from "../src/context-types.js";
import type { ManifestEntry } from "../src/ingest-manifest.js";
import { sha256Hex } from "../src/ingest-manifest.js";
import { domainName } from "../src/domain.js";

const DOMAIN = "test";
const NAMESPACE = env.CONTEXT_COLLECTIONS_TEST as DurableObjectNamespace<ContextCollectionDurableObject>;

// Address the DO exactly as production does, so the test cannot drift from the real naming.
function stub(collectionId: string) {
  return NAMESPACE.get(NAMESPACE.idFromName(domainName(DOMAIN, collectionId)));
}

function metadata(id: string, source: "push" | "web"): ContextCollectionMetadata {
  return {
    id,
    title: `Collection ${id}`,
    description: "Test collection.",
    visibility: "public",
    created: new Date(0),
    lastUpdated: new Date(0),
    documentCount: 0,
    content: source === "push" ? { source: "push" } : { source: "web" },
  };
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

async function newCollection(source: "push" | "web" = "push") {
  let id = crypto.randomUUID();
  let collection = stub(id);
  await collection.initialize(metadata(id, source), DOMAIN, "");
  return collection;
}

// Publish a whole set in one plan/upload/commit cycle.
async function publish(
    collection: DurableObjectStub<ContextCollectionDurableObject>,
    token: string, commit: string, files: Record<string, string>) {
  let manifest = await Promise.all(
    Object.entries(files).map(([path, body]) => entry(path, body)));
  let plan = await collection.planIngest(commit, manifest, false);
  if (plan.status !== "planned") return plan;
  let documents = await Promise.all(
    plan.needed.map(async path => upload(path, files[path], await hashOf(files[path]))));
  if (documents.length > 0) await collection.stageDocuments(plan.sessionId, documents);
  return collection.commitIngest(plan.sessionId, manifest);
}

describe("collection publication", () => {
  let collection: DurableObjectStub<ContextCollectionDurableObject>;
  let token: string;

  beforeEach(async () => {
    collection = await newCollection();
    token = (await collection.createIngestToken()).plaintext;
  });

  it("publishes a document set and stores it", async () => {
    let outcome = await publish(collection, token, "c1", { "a.md": "# A", "b.md": "# B" });
    expect(outcome).toMatchObject({ status: "applied", added: 2, updated: 0, deleted: 0 });

    let documents = await collection.listContextDocuments();
    expect(documents.map(d => d.path).toSorted()).toEqual(["a.md", "b.md"]);
  });

  it("asks only for the documents that changed", async () => {
    await publish(collection, token, "c1", { "a.md": "# A", "b.md": "# B" });

    let manifest = [await entry("a.md", "# A"), await entry("b.md", "# B v2")];
    let plan = await collection.planIngest("c2", manifest, false);

    expect(plan).toMatchObject({ status: "planned", needed: ["b.md"], unchanged: 1, toDelete: 0 });
  });

  it("treats a repeated commit as unchanged and opens no session", async () => {
    await publish(collection, token, "c1", { "a.md": "# A" });
    let plan = await collection.planIngest("c1", [await entry("a.md", "# A")], false);
    expect(plan).toEqual({ status: "unchanged", commit: "c1" });
  });

  it("refuses an empty manifest unless told otherwise", async () => {
    await publish(collection, token, "c1", { "a.md": "# A" });
    expect(await collection.planIngest("c2", [], false)).toEqual({ status: "empty-refused" });
    expect(await collection.planIngest("c2", [], true)).toMatchObject({ status: "planned" });
  });

  it("deletes documents absent from the manifest and leaves unchanged ones alone", async () => {
    await publish(collection, token, "c1", { "keep.md": "# Keep", "gone.md": "# Gone" });
    let outcome = await publish(collection, token, "c2", { "keep.md": "# Keep" });

    expect(outcome).toMatchObject({ status: "applied", added: 0, updated: 0, deleted: 1 });
    expect((await collection.listContextDocuments()).map(d => d.path)).toEqual(["keep.md"]);
    let meta = await collection.getMetadata();
    expect(meta.documentCount).toBe(1);
    expect(meta.content).toMatchObject({ source: "push", commit: "c2" });
  });

  it("refuses to commit while uploads are outstanding, changing nothing", async () => {
    let manifest = [await entry("a.md", "# A"), await entry("b.md", "# B")];
    let plan = await collection.planIngest("c1", manifest, false);
    if (plan.status !== "planned") throw new Error("expected a session");

    await collection.stageDocuments(plan.sessionId, [upload("a.md", "# A", await hashOf("# A"))]);
    expect(await collection.commitIngest(plan.sessionId, manifest))
      .toEqual({ status: "incomplete", missing: 1 });
    expect(await collection.listContextDocuments()).toEqual([]);
  });

  it("refuses a commit whose manifest differs from the planned one", async () => {
    let manifest = [await entry("a.md", "# A")];
    let plan = await collection.planIngest("c1", manifest, false);
    if (plan.status !== "planned") throw new Error("expected a session");
    await collection.stageDocuments(plan.sessionId, [upload("a.md", "# A", await hashOf("# A"))]);

    expect(await collection.commitIngest(plan.sessionId, [await entry("a.md", "# different")]))
      .toEqual({ status: "manifest-mismatch" });
  });

  it("discards a previous session when a new plan starts", async () => {
    let manifest = [await entry("a.md", "# A")];
    let first = await collection.planIngest("c1", manifest, false);
    if (first.status !== "planned") throw new Error("expected a session");
    await collection.stageDocuments(first.sessionId, [upload("a.md", "# A", await hashOf("# A"))]);

    let second = await collection.planIngest("c2", manifest, false);
    if (second.status !== "planned") throw new Error("expected a session");

    expect(await collection.stageDocuments(first.sessionId, [])).toEqual({ status: "no-session" });
    expect(await collection.commitIngest(first.sessionId, manifest)).toEqual({ status: "no-session" });
    // The new session starts from an empty staging area, so it still needs the document.
    expect(await collection.commitIngest(second.sessionId, manifest))
      .toEqual({ status: "incomplete", missing: 1 });
  });

  it("aborts a commit that resumes after a concurrent replan replaced its session", async () => {
    // Reproduces the race commitIngest's single await opens: session A is read and passes its
    // top-of-method check, then commitIngest awaits hashManifest(). If a second plan+stage cycle
    // (session B) runs to completion during that await, A must not apply B's staged documents under
    // A's commit when it resumes. That requires genuine interleaving of two in-flight DO calls, which
    // this harness does not otherwise produce (a bare unawaited call plus a following await never let
    // a second call make progress first — verified empirically). So the one call that does yield
    // control mid-flight, crypto.subtle.digest() inside hashManifest(), is paused deliberately: this
    // pins commitIngest(A) at exactly the await the fix guards, runs B's whole plan+stage cycle to
    // completion, then releases it. B stages the same path+hash A wants, so the pre-existing
    // hash-cross-check (a separate, already-covered guard) does not by itself short-circuit the race
    // before reaching the check under test.
    let manifestA = [await entry("a.md", "# A")];
    let planA = await collection.planIngest("c1", manifestA, false);
    if (planA.status !== "planned") throw new Error("expected a session");
    await collection.stageDocuments(planA.sessionId, [upload("a.md", "# A", await hashOf("# A"))]);

    let outcome = await runInDurableObject(collection, async (instance) => {
      let realDigest = crypto.subtle.digest.bind(crypto.subtle);
      let callCount = 0;
      let release: () => void = () => {};
      let paused = new Promise<void>(resolve => { release = resolve; });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (crypto.subtle as any).digest = async (...args: unknown[]) => {
        callCount++;
        // Only the first digest — commitIngest(A)'s own hashManifest() call, issued below — pauses;
        // every later one (session B's planIngest) proceeds normally so B can actually complete.
        if (callCount === 1) await paused;
        return realDigest(...(args as Parameters<typeof realDigest>));
      };

      try {
        let commitAPromise = instance.commitIngest(planA.sessionId, manifestA);

        let manifestB = [await entry("a.md", "# A")];
        let planB = await instance.planIngest("c2", manifestB, false);
        if (planB.status !== "planned") throw new Error("expected a second session");
        await instance.stageDocuments(planB.sessionId, [upload("a.md", "# A", await hashOf("# A"))]);

        release();
        let commitAResult = await commitAPromise;
        let meta = await instance.getMetadata();
        return { commitAResult, metaCommit: meta.content.commit, sessionBId: planB.sessionId };
      } finally {
        (crypto.subtle as any).digest = realDigest;
      }
    });

    // The stale session must be refused, not silently applied under commit "c1" ...
    expect(outcome.commitAResult).toEqual({ status: "no-session" });
    // ... and the collection's recorded commit must be untouched by it.
    expect(outcome.metaCommit).toBeUndefined();

    // Session B, untouched by A's aborted attempt, can still commit normally afterward using the
    // session it already staged — replanning here would itself discard that staging (see the
    // "discards a previous session" test above), which isn't what this test is checking.
    expect(await collection.commitIngest(outcome.sessionBId, [await entry("a.md", "# A")]))
      .toMatchObject({ status: "applied", commit: "c2" });
  });

  it("rejects tokens that are unknown, revoked, or minted for another collection", async () => {
    let created = await collection.createIngestToken();
    expect(await collection.verifyIngestToken(created.plaintext)).toBe(true);
    expect(await collection.revokeIngestToken(created.id)).toBe(true);
    expect(await collection.verifyIngestToken(created.plaintext)).toBe(false);

    expect(await collection.verifyIngestToken("nonsense")).toBe(false);
    expect(await collection.verifyIngestToken("")).toBe(false);

    let other = await newCollection();
    let otherToken = (await other.createIngestToken()).plaintext;
    expect(await collection.verifyIngestToken(otherToken)).toBe(false);
  });

  it("refuses to plan against a collection that is not a push collection", async () => {
    let web = await newCollection("web");
    expect(await web.planIngest("c1", [], false)).toEqual({ status: "wrong-source" });
  });

  it("lists tokens without ever exposing their plaintext", async () => {
    let created = await collection.createIngestToken();
    let listed = await collection.listIngestTokens();
    expect(listed.tokens.some(t => t.id === created.id)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(created.plaintext);
  });

  it("indexes a published SKILL.md as an agent skill", async () => {
    let skill = "---\nname: release-check\ndescription: How to check a release.\n---\n\nSteps.";
    await publish(collection, token, "c1", { "SKILL.md": skill });
    let documents = await collection.listContextDocuments();
    expect(documents[0]).toMatchObject({ skillName: "release-check" });
  });
});
