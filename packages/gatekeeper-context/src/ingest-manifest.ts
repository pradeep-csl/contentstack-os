// Manifest parsing, hashing and diffing for CI publication. Pure: no storage and no network, so the
// protocol's arithmetic is unit-testable directly.

import { z } from "zod";
import {
  ContextDocument, MAX_DOCUMENT_BODY_BYTES, contentTypeFromPath, isTextContentType,
} from "./context-types.js";
import { extractDescription } from "./description-extractors.js";
import { baseName, isValidDocumentPath } from "./document-path.js";

// Per-request ceiling. Batches are bounded by the publisher, so this does not grow with the
// repository — a 15 MB wiki and a 150 MB one both publish in batches under this size.
export const MAX_INGEST_BODY_BYTES = 5 * 1024 * 1024;

// Ceiling on files in one publication.
export const MAX_MANIFEST_ENTRIES = 5_000;

const HEX_SHA256 = /^[0-9a-f]{64}$/;

const ManifestEntrySchema = z.object({
  path: z.string().min(1),
  hash: z.string().regex(HEX_SHA256, "hash must be lowercase hex SHA-256"),
});

// One file's identity in the desired state.
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

// The desired state. Paths must be unique: the manifest is a set keyed by path everywhere it is
// consumed — staging, the stored documents, the delete pass — so a repeated path describes a state
// no collection can hold, and would otherwise leave the publication permanently uncommittable.
const ManifestSchema = z.array(ManifestEntrySchema).max(MAX_MANIFEST_ENTRIES).refine(
  entries => new Set(entries.map(entry => entry.path)).size === entries.length,
  "manifest contains duplicate paths");

const UploadDocumentSchema = z.object({
  path: z.string().min(1),
  body: z.string(),
  encoding: z.literal("base64").optional(),
  // Declared by the publisher and verified on arrival, so a truncated transfer cannot be committed.
  hash: z.string().regex(HEX_SHA256),
});

// One document being transferred.
export type UploadDocument = z.infer<typeof UploadDocumentSchema>;

export const PlanRequestSchema = z.object({
  commit: z.string().min(1).max(255),
  manifest: ManifestSchema,
  // An empty manifest means "delete everything" — valid, but only when the caller says so.
  allowEmpty: z.boolean().optional(),
});

export const UploadRequestSchema = z.object({
  sessionId: z.string().min(1),
  documents: z.array(UploadDocumentSchema),
});

export const CommitRequestSchema = z.object({
  sessionId: z.string().min(1),
  manifest: ManifestSchema,
});

// The raw bytes of a body as sent, which is what both sides hash.
export function bodyBytes(body: string, encoding?: "base64"): Uint8Array {
  if (encoding === "base64") {
    let binary = atob(body);
    let bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(body);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  let digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

// A manifest's identity, order-independent so the publisher's file ordering cannot invalidate a
// session between plan and commit.
export async function hashManifest(entries: ManifestEntry[]): Promise<string> {
  let canonical = entries
    .map(entry => `${entry.path} ${entry.hash}`)
    .toSorted()
    .join("\n");
  return sha256Hex(new TextEncoder().encode(canonical));
}

// What the collection lacks, given the manifest and the hashes it already stores. A stored value of
// undefined means the document predates hashing, so it must be re-sent.
export function planUploads(
    manifest: ManifestEntry[],
    stored: Map<string, string | undefined>,
): { needed: string[]; unchanged: number; toDelete: string[] } {
  let needed: string[] = [];
  let unchanged = 0;
  let wanted = new Set<string>();

  for (let entry of manifest) {
    wanted.add(entry.path);
    if (stored.get(entry.path) === entry.hash) unchanged++;
    else needed.push(entry.path);
  }

  return { needed, unchanged, toDelete: [...stored.keys()].filter(path => !wanted.has(path)) };
}

// Why an upload was refused outright rather than staged.
export type UploadRejection = { path: string; reason: "invalid-path" | "too-large" | "hash-mismatch" };

// Validate one upload against its declared hash and the storage limits. Unlike the git path, an
// oversized document is a hard error rather than a silent skip: commit requires every needed path, so
// skipping one would fail the publication later with a far less obvious message.
export async function validateUpload(upload: UploadDocument): Promise<UploadRejection | null> {
  if (!isValidDocumentPath(upload.path)) return { path: upload.path, reason: "invalid-path" };
  if (new TextEncoder().encode(upload.body).length > MAX_DOCUMENT_BODY_BYTES) {
    return { path: upload.path, reason: "too-large" };
  }
  if (await sha256Hex(bodyBytes(upload.body, upload.encoding)) !== upload.hash) {
    return { path: upload.path, reason: "hash-mismatch" };
  }
  return null;
}

// Turn a validated upload into a storable document. Content type, name and description are derived
// here rather than by the client, so published documents are indistinguishable from any other source
// and parsing rules can evolve without changing every repository's workflow.
export function normalizeUpload(upload: UploadDocument): ContextDocument & { hash: string } {
  let contentType = contentTypeFromPath(upload.path);
  let isText = isTextContentType(contentType);
  return {
    path: upload.path,
    name: baseName(upload.path),
    description: isText ? extractDescription(contentType, upload.body) ?? "" : "",
    contentType,
    body: upload.body,
    hash: upload.hash,
    lastUpdated: new Date(),
  };
}
