// HTTP surface for CI publication: plan, upload, commit. The collection is reached through an
// injected resolver rather than a Durable Object namespace, so routing, ordering and status codes are
// testable without a Worker runtime.

import type { ContextDocument } from "./context-types.js";
import {
  CommitRequestSchema, MAX_INGEST_BODY_BYTES, type ManifestEntry, PlanRequestSchema,
  UploadRequestSchema, type UploadRejection, normalizeUpload, validateUpload,
} from "./ingest-manifest.js";

// The router forwards requests unmodified, so the gatekeeper sees its own prefix. Exported so the
// worker entrypoint can rate-limit ingestion requests without restating the path.
export const INGEST_PATH_PREFIX = "/gatekeeper/context/ingest/";

// A document ready to stage.
export type StagedDocument = ContextDocument & { hash: string };

export type PlanOutcome =
  | { status: "wrong-source" }
  | { status: "unchanged"; commit: string }
  | { status: "empty-refused" }
  | { status: "planned"; sessionId: string; needed: string[]; unchanged: number; toDelete: number };

export type StageOutcome =
  | { status: "no-session" }
  | { status: "staged"; staged: number; remaining: number };

export type CommitOutcome =
  | { status: "no-session" }
  | { status: "manifest-mismatch" }
  | { status: "incomplete"; missing: number }
  | { status: "applied"; commit: string; added: number; updated: number; deleted: number;
      documentCount: number };

// The slice of the collection this handler needs. Verification is separate from the rest so the token
// can be checked before the body is read.
export type IngestTarget = {
  verifyIngestToken(token: string): Promise<boolean>;
  planIngest(commit: string, manifest: ManifestEntry[], allowEmpty: boolean): Promise<PlanOutcome>;
  stageDocuments(sessionId: string, documents: StagedDocument[]): Promise<StageOutcome>;
  commitIngest(sessionId: string, manifest: ManifestEntry[]): Promise<CommitOutcome>;
};

// Resolves the collection addressed by the request path.
export type ResolveIngestTarget = (domain: string, collectionId: string) => IngestTarget;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

// Handle an ingestion request, or return null when this is not one so the caller can fall through.
export async function handleIngestRequest(
    request: Request, resolve: ResolveIngestTarget): Promise<Response | null> {
  let url = new URL(request.url);
  if (!url.pathname.startsWith(INGEST_PATH_PREFIX)) return null;

  let segments = url.pathname.slice(INGEST_PATH_PREFIX.length).split("/").filter(s => s.length > 0);
  if (segments.length !== 3) return json(404, { error: "not found" });
  let [domain, collectionId, action] = segments.map(decodeURIComponent);
  if (action !== "plan" && action !== "upload" && action !== "commit") {
    return json(404, { error: "not found" });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405, headers: { "content-type": "application/json", allow: "POST" },
    });
  }

  // The token carries all authority; the path carries none.
  let authorization = request.headers.get("authorization") ?? "";
  let token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!token) return json(401, { error: "unauthorized" });

  // Authenticate before touching the body. The reverse order lets anyone with a junk token force a
  // multi-megabyte read and parse against a public endpoint.
  let target = resolve(domain, collectionId);
  if (!await target.verifyIngestToken(token)) return json(401, { error: "unauthorized" });

  let declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_INGEST_BODY_BYTES) {
    return json(413, { error: "payload too large" });
  }

  let raw = await request.text();
  // Content-Length is a claim, not a guarantee; check what actually arrived.
  if (new TextEncoder().encode(raw).length > MAX_INGEST_BODY_BYTES) {
    return json(413, { error: "payload too large" });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "body is not valid JSON" });
  }

  if (action === "plan") return handlePlan(body, target);
  if (action === "upload") return handleUpload(body, target);
  return handleCommit(body, target);
}

async function handlePlan(body: unknown, target: IngestTarget): Promise<Response> {
  let parsed = PlanRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: describe(parsed.error.issues) });

  let outcome = await target.planIngest(
    parsed.data.commit, parsed.data.manifest, parsed.data.allowEmpty ?? false);

  switch (outcome.status) {
    case "wrong-source":
      return json(409, { error: "collection does not accept CI publication" });
    case "empty-refused":
      return json(422, { error: "refusing to empty the collection; set allowEmpty to confirm" });
    case "unchanged":
      return json(200, { status: "unchanged", commit: outcome.commit });
    case "planned":
      return json(200, {
        status: "planned",
        sessionId: outcome.sessionId,
        needed: outcome.needed,
        unchanged: outcome.unchanged,
        toDelete: outcome.toDelete,
      });
  }
}

async function handleUpload(body: unknown, target: IngestTarget): Promise<Response> {
  let parsed = UploadRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: describe(parsed.error.issues) });

  // Validate the whole batch before staging any of it: a partially staged batch would fail at commit
  // as "incomplete", which is a far less useful message than naming the document that was wrong.
  let rejected: UploadRejection[] = [];
  for (let upload of parsed.data.documents) {
    let rejection = await validateUpload(upload);
    if (rejection) rejected.push(rejection);
  }
  if (rejected.length > 0) {
    return json(400, { error: "one or more documents were rejected", rejected });
  }

  let outcome = await target.stageDocuments(
    parsed.data.sessionId, parsed.data.documents.map(normalizeUpload));

  return outcome.status === "no-session"
    ? json(409, { error: "no open publication session" })
    : json(200, { status: "staged", staged: outcome.staged, remaining: outcome.remaining });
}

async function handleCommit(body: unknown, target: IngestTarget): Promise<Response> {
  let parsed = CommitRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: describe(parsed.error.issues) });

  let outcome = await target.commitIngest(parsed.data.sessionId, parsed.data.manifest);

  switch (outcome.status) {
    case "no-session":
      return json(409, { error: "no open publication session" });
    case "manifest-mismatch":
      return json(409, { error: "manifest does not match the one this session planned" });
    case "incomplete":
      return json(409, { error: `still waiting for ${outcome.missing} document(s)` });
    case "applied":
      return json(200, {
        status: "applied",
        commit: outcome.commit,
        added: outcome.added,
        updated: outcome.updated,
        deleted: outcome.deleted,
        documentCount: outcome.documentCount,
      });
  }
}

function describe(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}
