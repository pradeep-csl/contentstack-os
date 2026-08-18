import { describe, expect, it } from "vitest";
import type {
  CommitOutcome, PlanOutcome, ResolveIngestTarget, StageOutcome,
} from "../src/ingest-handler.js";
import { handleIngestRequest } from "../src/ingest-handler.js";
import { MAX_INGEST_BODY_BYTES, sha256Hex } from "../src/ingest-manifest.js";

const BASE = "https://workshop.example.com/gatekeeper/context/ingest/dev/col-1";

async function hashOf(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

type Outcomes = { plan?: PlanOutcome; stage?: StageOutcome; commit?: CommitOutcome };

// Records what reached the collection, and replies with scripted outcomes.
function fakeResolver(outcomes: Outcomes, tokenValid = true) {
  let planned: { commit: string; paths: string[]; allowEmpty: boolean }[] = [];
  let staged: string[][] = [];
  let committed: { sessionId: string; entries: number }[] = [];

  let resolve: ResolveIngestTarget = () => ({
    async verifyIngestToken() {
      return tokenValid;
    },
    async planIngest(commit, manifest, allowEmpty) {
      planned.push({ commit, paths: manifest.map(e => e.path), allowEmpty });
      return outcomes.plan ?? { status: "planned", sessionId: "s1", needed: [], unchanged: 0, toDelete: 0 };
    },
    async stageDocuments(_sessionId, documents) {
      staged.push(documents.map(d => d.path));
      return outcomes.stage ?? { status: "staged", staged: documents.length, remaining: 0 };
    },
    async commitIngest(sessionId, manifest) {
      committed.push({ sessionId, entries: manifest.length });
      return outcomes.commit ?? {
        status: "applied", commit: "c1", added: 0, updated: 0, deleted: 0, documentCount: 0,
      };
    },
  });

  return { resolve, planned, staged, committed };
}

function post(action: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`${BASE}/${action}`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      ...init.headers,
    },
    body: JSON.stringify(body),
    ...init,
  });
}

describe("routing and authentication", () => {
  it("ignores paths that are not ingestion paths", async () => {
    let { resolve } = fakeResolver({});
    expect(await handleIngestRequest(new Request("https://x.example.com/health"), resolve)).toBeNull();
  });

  it("404s an unknown action and a malformed path", async () => {
    let { resolve } = fakeResolver({});
    expect((await handleIngestRequest(post("frobnicate", {}), resolve))!.status).toBe(404);
    expect((await handleIngestRequest(
      new Request(`${BASE}`, { method: "POST" }), resolve))!.status).toBe(404);
  });

  it("rejects non-POST methods", async () => {
    let { resolve } = fakeResolver({});
    let response = await handleIngestRequest(
      new Request(`${BASE}/plan`, { method: "GET" }), resolve);
    expect(response!.status).toBe(405);
  });

  it("rejects a missing or malformed authorization header", async () => {
    let { resolve, planned } = fakeResolver({});
    let none = await handleIngestRequest(post("plan", {}, { headers: { authorization: "" } }), resolve);
    let basic = await handleIngestRequest(
      post("plan", {}, { headers: { authorization: "Basic abc" } }), resolve);

    expect(none!.status).toBe(401);
    expect(basic!.status).toBe(401);
    expect(planned).toEqual([]);
  });

  it("rejects the token before reading the body", async () => {
    // Malformed JSON under a bad token must fail authentication, not parsing. If this returns 400 the
    // ordering has regressed and an unauthenticated caller can force a full read and parse.
    let { resolve, planned } = fakeResolver({}, false);
    let response = await handleIngestRequest(new Request(`${BASE}/plan`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "{not json",
    }), resolve);

    expect(response!.status).toBe(401);
    expect(planned).toEqual([]);
  });
});

describe("size limits", () => {
  it("413s a request whose declared Content-Length exceeds the cap, without reading the body", async () => {
    // The header precheck is a cheap short-circuit: it must fire on the declared size alone, before
    // any read is attempted, so a hostile Content-Length can't force a large read.
    let { resolve, planned } = fakeResolver({});
    let response = await handleIngestRequest(new Request(`${BASE}/plan`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-length": String(MAX_INGEST_BODY_BYTES + 1),
      },
      body: "tiny",
    }), resolve);

    expect(response!.status).toBe(413);
    expect(planned).toEqual([]);
  });

  it("413s a body that exceeds the cap even when Content-Length understates it", async () => {
    // Content-Length is a claim, not a guarantee: a caller can send a small declared size alongside a
    // large body, so the actual bytes received must be checked too, independent of the header.
    let { resolve, planned } = fakeResolver({});
    let oversized = "x".repeat(MAX_INGEST_BODY_BYTES + 1);
    let response = await handleIngestRequest(new Request(`${BASE}/plan`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-length": "1" },
      body: oversized,
    }), resolve);

    expect(response!.status).toBe(413);
    expect(planned).toEqual([]);
  });
});

describe("plan", () => {
  it("passes the manifest through and reports what is needed", async () => {
    let { resolve, planned } = fakeResolver({
      plan: { status: "planned", sessionId: "s9", needed: ["a.md"], unchanged: 3, toDelete: 1 },
    });
    let response = await handleIngestRequest(post("plan", {
      commit: "c2",
      manifest: [{ path: "a.md", hash: await hashOf("A") }],
    }), resolve);

    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      status: "planned", sessionId: "s9", needed: ["a.md"], unchanged: 3, toDelete: 1,
    });
    expect(planned).toEqual([{ commit: "c2", paths: ["a.md"], allowEmpty: false }]);
  });

  it("reports an unchanged commit without opening a session", async () => {
    let { resolve } = fakeResolver({ plan: { status: "unchanged", commit: "c2" } });
    let response = await handleIngestRequest(post("plan", {
      commit: "c2", manifest: [{ path: "a.md", hash: await hashOf("A") }],
    }), resolve);

    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ status: "unchanged", commit: "c2" });
  });

  it("refuses an empty manifest unless the caller confirms", async () => {
    let { resolve } = fakeResolver({ plan: { status: "empty-refused" } });
    let response = await handleIngestRequest(post("plan", { commit: "c3", manifest: [] }), resolve);
    expect(response!.status).toBe(422);
  });

  it("rejects a manifest whose hashes are not SHA-256 hex", async () => {
    let { resolve, planned } = fakeResolver({});
    let response = await handleIngestRequest(post("plan", {
      commit: "c4", manifest: [{ path: "a.md", hash: "nope" }],
    }), resolve);

    expect(response!.status).toBe(400);
    expect(planned).toEqual([]);
  });

  it("returns 409 for a collection that does not accept publications", async () => {
    let { resolve } = fakeResolver({ plan: { status: "wrong-source" } });
    let response = await handleIngestRequest(post("plan", {
      commit: "c5", manifest: [{ path: "a.md", hash: await hashOf("A") }],
    }), resolve);
    expect(response!.status).toBe(409);
  });
});

describe("upload", () => {
  it("stages documents whose bodies match their hashes", async () => {
    let { resolve, staged } = fakeResolver({ stage: { status: "staged", staged: 1, remaining: 2 } });
    let response = await handleIngestRequest(post("upload", {
      sessionId: "s1",
      documents: [{ path: "a.md", body: "A", hash: await hashOf("A") }],
    }), resolve);

    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ status: "staged", staged: 1, remaining: 2 });
    expect(staged).toEqual([["a.md"]]);
  });

  it("rejects the whole batch when any body fails its hash, staging nothing", async () => {
    let { resolve, staged } = fakeResolver({});
    let response = await handleIngestRequest(post("upload", {
      sessionId: "s1",
      documents: [
        { path: "good.md", body: "A", hash: await hashOf("A") },
        { path: "bad.md", body: "tampered", hash: await hashOf("B") },
      ],
    }), resolve);

    expect(response!.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: "one or more documents were rejected",
      rejected: [{ path: "bad.md", reason: "hash-mismatch" }],
    });
    expect(staged).toEqual([]);
  });

  it("returns 409 when the session is gone", async () => {
    let { resolve } = fakeResolver({ stage: { status: "no-session" } });
    let response = await handleIngestRequest(post("upload", {
      sessionId: "stale", documents: [{ path: "a.md", body: "A", hash: await hashOf("A") }],
    }), resolve);
    expect(response!.status).toBe(409);
  });
});

describe("commit", () => {
  it("applies and reports the counts", async () => {
    let { resolve, committed } = fakeResolver({
      commit: {
        status: "applied", commit: "c6", added: 2, updated: 1, deleted: 3, documentCount: 40,
      },
    });
    let response = await handleIngestRequest(post("commit", {
      sessionId: "s1", manifest: [{ path: "a.md", hash: await hashOf("A") }],
    }), resolve);

    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      status: "applied", commit: "c6", added: 2, updated: 1, deleted: 3, documentCount: 40,
    });
    expect(committed).toEqual([{ sessionId: "s1", entries: 1 }]);
  });

  it("returns 409 for a stale session, a mismatched manifest, or outstanding uploads", async () => {
    for (let outcome of [
      { status: "no-session" } as const,
      { status: "manifest-mismatch" } as const,
      { status: "incomplete", missing: 2 } as const,
    ]) {
      let { resolve } = fakeResolver({ commit: outcome });
      let response = await handleIngestRequest(post("commit", {
        sessionId: "s1", manifest: [{ path: "a.md", hash: await hashOf("A") }],
      }), resolve);
      expect(response!.status).toBe(409);
    }
  });
});
