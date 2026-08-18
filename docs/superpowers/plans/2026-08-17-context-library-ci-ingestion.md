# Context Library CI Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a GitHub repository publish its content into a Context Library collection over an authenticated HTTP protocol that transfers only what changed, so every Workshop agent can search and read it.

**Architecture:** A new `push` content source on a collection, fed by three routes under `/gatekeeper/context/ingest/<sharingDomain>/<collectionId>/` — `plan`, `upload`, `commit` — each authenticated with the same bearer token. CI sends a manifest of every file and its hash; the collection replies with only the paths it lacks; CI uploads those in bounded batches; commit applies everything in one transaction and deletes whatever the manifest no longer lists. Request size stays bounded no matter how large the repository is, and writes are proportional to what changed rather than to repository size. Pure logic (manifest diffing, hashing, HTTP routing) lives in its own modules so it can be unit-tested without a Worker runtime.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, `@gadgets/typed-storage`, zod v4, vitest (plain, plus `@cloudflare/vitest-pool-workers` for DO tests), WebCrypto.

## Global Constraints

- **Package manager is pnpm, never npm.**
- Every command runs from the repo root unless stated otherwise. The package directory is `packages/gatekeeper-context`.
- Gates before every commit: `pnpm lint:check` and `pnpm types:check` must pass.
- Never add AI/LLM attribution or `Co-Authored-By` metadata to commit messages.
- Follow the surrounding style: `let` over `const` for locals, 2-space indent, `.js` extensions on relative imports, `//` doc comments on exported members explaining *why*.
- Server-side logging uses the package's existing `obsContext.createLogger({ component: "gatekeeper.context", vendorId: VENDOR_ID })`. Emit concrete `event` names. **Never log token plaintext, hashes, or document bodies.**
- This phase ships **global knowledge only**. Do not add any per-user or per-department permission model.
- **Do not wire ingested content into `AdminConfig.instanceInstructions`.** That value is appended to the agent's system prompt, so sourcing it from a repository would let anyone with merge rights rewrite the agent's instructions deployment-wide. Ingested content is documents and skills, which the agent reads as untrusted data.
- **Extension seam (from the spec, non-negotiable):** ingestion must not depend on a collection's visibility. Nothing in the endpoint, the token check, or the `push` source may assume `public`.
- **Per-request ceiling is provisional.** `MAX_INGEST_BODY_BYTES` is 5 MB pending Task 0. It bounds one batch, not one publication, so it does not grow with the repository — lower it if Task 0 says so, but never raise it without that measurement.
- **Transfer only what changed.** Nothing may reintroduce whole-set replacement for published collections: it is the write amplification this protocol exists to avoid. Persisting the manifest per file would do it too.
- **Admin invariant:** a *global* collection is a `public` collection, and only a deployment admin may create one or write to it. This is enforced by the existing `#assertAdmin()` / `#assertCanWrite()` checks in `context-api.ts` — do not add a parallel admin check, and do not weaken these. Ingestion token methods must go through `#assertCanWrite`, so admin authority is required to *mint* a token; the token is the authority thereafter, since CI has no user session.

---

## File Structure

**New files** (all under `packages/gatekeeper-context/`):

| File | Responsibility |
|---|---|
| `src/document-path.ts` | Document path rules, moved out of `context-collection.ts` so the web CRUD path and ingestion share one definition. Pure. |
| `src/ingest-manifest.ts` | Manifest schemas, hashing, diffing and upload validation. Pure. |
| `src/ingest-token.ts` | Mints and hashes ingestion tokens. Pure (WebCrypto only). |
| `src/ingest-handler.ts` | The plan/upload/commit routes: auth ordering, limits, response shaping. Takes an injected target resolver so it is testable without a Worker. |
| `__tests__/ingest-manifest.test.ts` | Unit tests for path rules, hashing and manifest diffing. |
| `__tests__/ingest-token.test.ts` | Unit tests for token minting and hashing. |
| `__tests__/ingest-handler.test.ts` | Unit tests for routing, status codes, and response bodies. |
| `__tests__/collection-ingest.workers.test.ts` | Durable Object tests: delta planning, staging, atomic commit, token isolation. |
| `__tests__/worker.ts` | Test-only Worker entrypoint for the DO test harness. |
| `vitest.workers.config.ts` | Workers-pool vitest config for the DO tests. |
| `docs/context-library-ingestion.md` | Admin onboarding steps plus the GitHub workflow departments copy. |
| `docs/examples/publish-context.mjs` | The publisher departments copy, kept as a runnable file rather than a YAML string. |

**Modified files:**

| File | Change |
|---|---|
| `src/context-types.ts` | `push` content variant; ingestion token types; `ContextApi` methods. |
| `src/context-collection.ts` | Import moved path helpers; document hashes; ingestion tokens; staging and session storage; `planIngest` / `stageDocuments` / `commitIngest`; reject web writes on push collections. |
| `src/context-api.ts` | Mint/list/revoke ingestion tokens; accept `"push"` in `createContextCollection`. |
| `src/index.ts` | Default export becomes a `WorkerEntrypoint` that routes ingestion requests. |
| `app/ContextLibraryPage.tsx` | "CI push" source option; ingestion token management modal. |
| `package.json` | Add `@cloudflare/vitest-pool-workers`; run both vitest configs. |
| `wrangler.jsonc` | Rate limiter binding for the public endpoint. |
| `src/env.d.ts` | Optional `INGEST_RATE_LIMITER` binding. |
| `scripts/release/manifest-lib.mjs` | Teach the release manifest about `ratelimits`, which it otherwise rejects. |

---

### Task 0: Workers test harness

Every later task's Durable Object tests depend on this, and the RPC measurement that follows cannot
run without it. Nothing but configuration — no product code.

**Files:**
- Modify: `packages/gatekeeper-context/package.json`
- Create: `packages/gatekeeper-context/vitest.workers.config.ts`
- Create: `packages/gatekeeper-context/__tests__/worker.ts`

**Interfaces:**
- Consumes: the three exported Durable Object classes in `packages/gatekeeper-context/src/`.
- Produces: a `vitest run -c vitest.workers.config.ts` suite that later tasks add files to, with
  `CONTEXT_COLLECTIONS_TEST`, `USER_LIBRARIES_TEST`, `REGISTRIES_TEST` and a `CONTEXT_COLLECTIONS` KV
  binding available via `cloudflare:test`.

- [ ] **Step 1: Add the test harness**

Add to `packages/gatekeeper-context/package.json` `devDependencies`, matching the versions
`gatekeeper-scheduler` already uses:

```json
"@cloudflare/vitest-pool-workers": "^0.16.20",
"miniflare": "4.20260625.0",
```

Change its `test` script to run both configs:

```json
"test": "vitest run && vitest run -c vitest.workers.config.ts",
```

Create `packages/gatekeeper-context/vitest.workers.config.ts`:

```ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
        // All three classes, because the admin-gating tests in Task 5 drive ContextApiImpl, which
        // touches the collection, the owner's library and the domain registry.
        durableObjects: {
          CONTEXT_COLLECTIONS_TEST: { className: "ContextCollectionDurableObject", useSQLite: true },
          USER_LIBRARIES_TEST: { className: "UserLibraryDurableObject", useSQLite: true },
          REGISTRIES_TEST: { className: "LibraryRegistryDurableObject", useSQLite: true },
        },
        // The registry writes its public-collections snapshot here (see registry-do.ts).
        kvNamespaces: ["CONTEXT_COLLECTIONS"],
      },
    }),
  ],
  test: {
    include: ["__tests__/*.workers.test.ts"],
  },
});
```

Create `packages/gatekeeper-context/__tests__/worker.ts`:

```ts
// Test-only entrypoint exposing the Durable Objects to the Workers test pool.

export { ContextCollectionDurableObject } from "../src/context-collection.js";
export { UserLibraryDurableObject } from "../src/user-library.js";
export { LibraryRegistryDurableObject } from "../src/registry-do.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("test worker");
  },
};
```

Run: `pnpm install`
Expected: succeeds, adding the two devDependencies.

- [ ] **Step 2: Verify the harness runs**

The suite has no test files yet, which vitest treats as an error, so prove the config loads by adding
a temporary smoke test at `packages/gatekeeper-context/__tests__/harness.workers.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("workers test harness", () => {
  it("exposes the collection, library and registry namespaces plus KV", () => {
    expect(env.CONTEXT_COLLECTIONS_TEST).toBeDefined();
    expect(env.USER_LIBRARIES_TEST).toBeDefined();
    expect(env.REGISTRIES_TEST).toBeDefined();
    expect(env.CONTEXT_COLLECTIONS).toBeDefined();
  });
});
```

Run: `cd packages/gatekeeper-context && pnpm vitest run -c vitest.workers.config.ts`
Expected: PASS.

Keep this file — it is a real assertion about the harness, and it stops the suite from being empty
until Task 4 adds the first Durable Object tests.

- [ ] **Step 3: Confirm the existing suite still passes**

Run: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: PASS for both configs — the 28 pre-existing tests plus the harness smoke test.

- [ ] **Step 4: Run the gates and commit**

```bash
pnpm lint:check && pnpm types:check
git add packages/gatekeeper-context/package.json \
        packages/gatekeeper-context/vitest.workers.config.ts \
        packages/gatekeeper-context/__tests__/worker.ts \
        packages/gatekeeper-context/__tests__/harness.workers.test.ts \
        pnpm-lock.yaml
git commit -m "test(context): add the Workers test harness"
```

---

### Measurement A: Durable Object RPC payload ceiling (run by the controller, not a subagent)

Publication batches cross a Durable Object RPC boundary, and **nothing in this codebase does that at
size today**. The git path never crosses RPC — `artifact-sync.ts` runs inside the DO, so documents are
produced locally — and the largest proven payload here is a single 1.4 MB document via
`putContextDocument`.

The manifest protocol already bounds every request to `MAX_INGEST_BODY_BYTES` (5 MB), so this is a
confirmation rather than a design gate: it tells you whether 5 MB batches are comfortable or whether
the publisher should use a smaller batch size. Cheap to run, and the spike is throwaway code that
should not be committed.

**Files:**
- Create (temporary, not committed): `packages/gatekeeper-context/__tests__/rpc-limit.workers.test.ts`

**Interfaces:**
- Consumes: the Workers test harness from Task 4. **Do Task 4's Step 1 first** (dependency and config
  only), then return here.
- Produces: a number that either confirms the 5 MB ceiling or forces the chunked design.

- [ ] **Step 1: Write the probe**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { domainName } from "../src/domain.js";

const NAMESPACE = env.CONTEXT_COLLECTIONS_TEST as DurableObjectNamespace<ContextCollectionDurableObject>;

// listContextDocuments on an uninitialized collection is a cheap round trip; what matters is how
// large an argument survives the crossing, so probe with an existing method that takes a string.
describe("durable object RPC payload ceiling", () => {
  for (let megabytes of [1, 5, 10, 20, 40]) {
    it(`carries a ${megabytes} MB argument`, async () => {
      let stub = NAMESPACE.get(NAMESPACE.idFromName(domainName("probe", `p${megabytes}`)));
      let payload = "x".repeat(megabytes * 1024 * 1024);
      await expect(stub.listContextDocuments(payload)).resolves.toBeDefined();
    });
  }
});
```

- [ ] **Step 2: Run it and record where it breaks**

Run: `cd packages/gatekeeper-context && pnpm vitest run -c vitest.workers.config.ts -t "RPC payload ceiling"`

Note the largest size that passes. Then decide:

- **Comfortably above 5 MB** — proceed as written.
- **At or below 5 MB** — lower `MAX_INGEST_BODY_BYTES` and the publisher's batch size to sit under the
  measured figure. No protocol change is needed; only the constant and the documented batch size move.

Also watch memory: the handler holds the batch body, its parsed form and the normalized documents
simultaneously, so the Worker's ceiling matters as much as the RPC's.

- [ ] **Step 3: Delete the probe**

```bash
rm packages/gatekeeper-context/__tests__/rpc-limit.workers.test.ts
```

Nothing to commit. Report the measured limit in the task's review notes.

---

### Task 1: Path rules, hashing, and manifest diffing

Everything the protocol needs that is pure arithmetic: what a legal path is, how a document is
hashed, which paths a manifest asks for that the collection lacks, and how an upload is validated.
Moving the path rules out of `context-collection.ts` also stops the web CRUD path and publication
from drifting apart.

**Files:**
- Create: `packages/gatekeeper-context/src/document-path.ts`
- Create: `packages/gatekeeper-context/src/ingest-manifest.ts`
- Modify: `packages/gatekeeper-context/src/context-collection.ts` (remove the moved helpers, import them)
- Test: `packages/gatekeeper-context/__tests__/ingest-manifest.test.ts`

**Interfaces:**
- Consumes: `ContextDocument`, `MAX_DOCUMENT_BODY_BYTES`, `contentTypeFromPath`, `isTextContentType`
  from `./context-types.js`; `extractDescription` from `./description-extractors.js`.
- Produces from `document-path.ts`: `validateDocumentPath(path): void` (throws),
  `isValidDocumentPath(path): boolean`, `baseName(path): string`, `MAX_DOCUMENT_PATH_LENGTH`.
- Produces from `ingest-manifest.ts`: `MAX_INGEST_BODY_BYTES`, `MAX_MANIFEST_ENTRIES`,
  `ManifestEntry`, `UploadDocument`, `PlanRequestSchema`, `UploadRequestSchema`,
  `CommitRequestSchema`, `bodyBytes(body, encoding?)`, `sha256Hex(bytes)`, `hashManifest(entries)`,
  `planUploads(manifest, stored)`, `normalizeUpload(upload)`, `validateUpload(upload)`,
  `UploadRejection`.

- [ ] **Step 1: Write the failing test**

Create `packages/gatekeeper-context/__tests__/ingest-manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { baseName, isValidDocumentPath } from "../src/document-path.js";
import {
  type ManifestEntry, bodyBytes, hashManifest, normalizeUpload, planUploads, sha256Hex,
  validateUpload,
} from "../src/ingest-manifest.js";

async function hashOf(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

describe("document paths", () => {
  it("accepts relative paths and rejects traversal, absolutes and control characters", () => {
    expect(isValidDocumentPath("pricing/discounts.md")).toBe(true);
    expect(isValidDocumentPath("/pricing.md")).toBe(false);
    expect(isValidDocumentPath("a/../b.md")).toBe(false);
    expect(isValidDocumentPath("a//b.md")).toBe(false);
    expect(isValidDocumentPath("a\u0000b.md")).toBe(false);
    expect(isValidDocumentPath("")).toBe(false);
  });

  it("derives the display name from the last segment", () => {
    expect(baseName("pricing/discounts.md")).toBe("discounts.md");
    expect(baseName("README.md")).toBe("README.md");
  });
});

describe("hashing", () => {
  it("hashes text and base64 bodies to the same digest as their raw bytes", async () => {
    expect(await sha256Hex(bodyBytes("hello"))).toBe(await hashOf("hello"));
    // "aGVsbG8=" is base64 for "hello", so both encodings must agree.
    expect(await sha256Hex(bodyBytes("aGVsbG8=", "base64"))).toBe(await hashOf("hello"));
  });

  it("hashes a manifest independently of entry order", async () => {
    let entries: ManifestEntry[] = [
      { path: "a.md", hash: await hashOf("A") },
      { path: "b.md", hash: await hashOf("B") },
    ];
    expect(await hashManifest(entries)).toBe(await hashManifest([...entries].reverse()));
  });

  it("changes the manifest hash when any entry changes", async () => {
    let base: ManifestEntry[] = [{ path: "a.md", hash: await hashOf("A") }];
    let changed: ManifestEntry[] = [{ path: "a.md", hash: await hashOf("A2") }];
    expect(await hashManifest(base)).not.toBe(await hashManifest(changed));
  });
});

describe("planUploads", () => {
  it("asks only for paths whose hash differs, is missing, or is unhashed", async () => {
    let manifest: ManifestEntry[] = [
      { path: "same.md", hash: await hashOf("same") },
      { path: "changed.md", hash: await hashOf("new") },
      { path: "new.md", hash: await hashOf("brand new") },
      { path: "legacy.md", hash: await hashOf("legacy") },
    ];
    let stored = new Map<string, string | undefined>([
      ["same.md", await hashOf("same")],
      ["changed.md", await hashOf("old")],
      ["legacy.md", undefined],
      ["gone.md", await hashOf("gone")],
    ]);

    let result = planUploads(manifest, stored);
    expect(result.needed.sort()).toEqual(["changed.md", "legacy.md", "new.md"]);
    expect(result.unchanged).toBe(1);
    expect(result.toDelete).toEqual(["gone.md"]);
  });

  it("reports every stored path as deletable for an empty manifest", async () => {
    let stored = new Map<string, string | undefined>([["a.md", await hashOf("a")]]);
    expect(planUploads([], stored)).toEqual({ needed: [], unchanged: 0, toDelete: ["a.md"] });
  });
});

describe("validateUpload", () => {
  it("accepts a body matching its declared hash", async () => {
    expect(await validateUpload({ path: "a.md", body: "A", hash: await hashOf("A") })).toBeNull();
  });

  it("rejects a body that does not match its hash", async () => {
    expect(await validateUpload({ path: "a.md", body: "tampered", hash: await hashOf("A") }))
      .toEqual({ path: "a.md", reason: "hash-mismatch" });
  });

  it("rejects invalid paths and oversized bodies", async () => {
    expect(await validateUpload({ path: "../a.md", body: "A", hash: await hashOf("A") }))
      .toEqual({ path: "../a.md", reason: "invalid-path" });

    let big = "x".repeat(1_400_001);
    expect(await validateUpload({ path: "big.md", body: big, hash: await hashOf(big) }))
      .toEqual({ path: "big.md", reason: "too-large" });
  });
});

describe("normalizeUpload", () => {
  it("derives content type, name and description, and keeps the hash", async () => {
    let body = "# Discount policy\n\nHow discounts work.";
    let doc = normalizeUpload({ path: "pricing/discounts.md", body, hash: await hashOf(body) });
    expect(doc.name).toBe("discounts.md");
    expect(doc.contentType).toBe("text/markdown");
    expect(doc.description).not.toBe("");
    expect(doc.hash).toBe(await hashOf(body));
  });

  it("leaves binary bodies base64 and gives them no description", async () => {
    let doc = normalizeUpload({
      path: "logo.png", body: "aGVsbG8=", encoding: "base64", hash: await hashOf("hello"),
    });
    expect(doc.contentType).toBe("image/png");
    expect(doc.body).toBe("aGVsbG8=");
    expect(doc.description).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: FAIL — cannot resolve `../src/document-path.js` and `../src/ingest-manifest.js`.

- [ ] **Step 3: Create the path module**

Create `packages/gatekeeper-context/src/document-path.ts` by moving the helpers verbatim out of
`context-collection.ts`:

```ts
// Document path rules, shared by the web CRUD path and CI publication so the two cannot drift apart.
// Pure, so the rules are unit-testable without a Durable Object.

export const MAX_DOCUMENT_PATH_LENGTH = 1024;

// Validate a document path before using it as a storage key.
export function validateDocumentPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Document path is required.");
  }
  if (path.length > MAX_DOCUMENT_PATH_LENGTH) {
    throw new Error(`Document path is too long (max ${MAX_DOCUMENT_PATH_LENGTH} characters).`);
  }
  if (path.startsWith("/")) {
    throw new Error("Document path must be relative (no leading '/').");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Document path must not contain control characters.");
  }
  for (let segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("Document path must not contain empty, '.', or '..' segments.");
    }
  }
}

// Whether a path is usable, for callers that reject entries rather than throwing.
export function isValidDocumentPath(path: string): boolean {
  try {
    validateDocumentPath(path);
    return true;
  } catch {
    return false;
  }
}

// Last path segment; document names derive from paths.
export function baseName(path: string): string {
  let i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}
```

In `context-collection.ts`, delete the local `MAX_DOCUMENT_PATH_LENGTH`, `validateDocumentPath` and
`baseName`, and import them instead. Leave `extOf` — it is only used locally.

```ts
import { baseName, validateDocumentPath } from "./document-path.js";
```

- [ ] **Step 4: Create the manifest module**

Create `packages/gatekeeper-context/src/ingest-manifest.ts`:

```ts
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
  manifest: z.array(ManifestEntrySchema).max(MAX_MANIFEST_ENTRIES),
  // An empty manifest means "delete everything" — valid, but only when the caller says so.
  allowEmpty: z.boolean().optional(),
});

export const UploadRequestSchema = z.object({
  sessionId: z.string().min(1),
  documents: z.array(UploadDocumentSchema),
});

export const CommitRequestSchema = z.object({
  sessionId: z.string().min(1),
  manifest: z.array(ManifestEntrySchema).max(MAX_MANIFEST_ENTRIES),
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
    .sort()
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: PASS — the new suites plus the 28 pre-existing tests.

- [ ] **Step 6: Run the gates and commit**

```bash
pnpm lint:check && pnpm types:check
git add packages/gatekeeper-context/src/document-path.ts \
        packages/gatekeeper-context/src/ingest-manifest.ts \
        packages/gatekeeper-context/src/context-collection.ts \
        packages/gatekeeper-context/__tests__/ingest-manifest.test.ts
git commit -m "feat(context): add manifest hashing and diffing for CI publication"
```

---

### Task 2: Ingestion token minting and hashing

**Files:**
- Create: `packages/gatekeeper-context/src/ingest-token.ts`
- Test: `packages/gatekeeper-context/__tests__/ingest-token.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Uses global `crypto` (WebCrypto), available in both Workers and the vitest Node environment.
- Produces:
  - `INGEST_TOKEN_TTL_SECONDS: number` (31_536_000 — one year, matching `GIT_TOKEN_TTL_SECONDS`)
  - `generateIngestToken(): { id: string; plaintext: string }`
  - `hashIngestToken(plaintext: string): Promise<string>` (hex HMAC-SHA-256)

- [ ] **Step 1: Write the failing test**

Create `packages/gatekeeper-context/__tests__/ingest-token.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateIngestToken, hashIngestToken } from "../src/ingest-token.js";

describe("ingest tokens", () => {
  it("mints unique high-entropy tokens", () => {
    let a = generateIngestToken();
    let b = generateIngestToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.id).not.toBe(b.id);
    // 128 bits as hex.
    expect(a.plaintext).toMatch(/^[0-9a-f]{32}$/);
  });

  it("hashes deterministically and differently per token", async () => {
    let token = generateIngestToken();
    let other = generateIngestToken();
    let hash = await hashIngestToken(token.plaintext);
    expect(await hashIngestToken(token.plaintext)).toBe(hash);
    expect(await hashIngestToken(other.plaintext)).not.toBe(hash);
    // SHA-256 as hex.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never returns the plaintext from the hash", async () => {
    let token = generateIngestToken();
    let hash = await hashIngestToken(token.plaintext);
    expect(hash).not.toContain(token.plaintext);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: FAIL — cannot resolve `../src/ingest-token.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/gatekeeper-context/src/ingest-token.ts`:

```ts
// Ingestion token minting and hashing. Only the hash is ever stored, so a storage leak yields nothing
// usable — the same shape the Workshop uses for share links (see docs/sharing.md).

// One year, matching the git token TTL so admins have a single rotation story.
export const INGEST_TOKEN_TTL_SECONDS = 31_536_000;

// Domain separation only; this is not a secret and does not need to be. The security of the stored
// value rests on the token's 128 bits of entropy, not on this key being hidden.
const INGEST_TOKEN_HMAC_KEY = "gadgets.context.ingest-token.v1";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

// Mint a token. The plaintext is shown to the operator once and never stored.
export function generateIngestToken(): { id: string; plaintext: string } {
  return {
    id: crypto.randomUUID(),
    plaintext: toHex(crypto.getRandomValues(new Uint8Array(16))),
  };
}

// Hash a token for storage and comparison. Comparing hashes of a high-entropy secret does not need a
// constant-time compare: a timing leak reveals a hash prefix, which is useless without a preimage.
export async function hashIngestToken(plaintext: string): Promise<string> {
  let key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(INGEST_TOKEN_HMAC_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  let signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(plaintext));
  return toHex(new Uint8Array(signature));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

```bash
pnpm lint:check && pnpm types:check
git add packages/gatekeeper-context/src/ingest-token.ts \
        packages/gatekeeper-context/__tests__/ingest-token.test.ts
git commit -m "feat(context): add ingestion token minting and hashing"
```

---

### Task 3: The three ingestion routes

The HTTP surface for `plan`, `upload` and `commit`. The collection is reached through an injected
resolver rather than a Durable Object namespace, so routing, ordering and every status code are
testable without a Worker runtime.

**Files:**
- Create: `packages/gatekeeper-context/src/ingest-handler.ts`
- Test: `packages/gatekeeper-context/__tests__/ingest-handler.test.ts`

**Interfaces:**
- Consumes: everything from `./ingest-manifest.js` (Task 1); `ContextDocument` from `./context-types.js`.
- Produces:
  - `INGEST_PATH_PREFIX: string`
  - `type PlanOutcome`, `type StageOutcome`, `type CommitOutcome` — the protocol vocabulary, defined
    here because the handler owns the wire contract and the collection implements it.
  - `type StagedDocument = ContextDocument & { hash: string }`
  - `type IngestTarget = { verifyIngestToken; planIngest; stageDocuments; commitIngest }`
  - `type ResolveIngestTarget = (domain: string, collectionId: string) => IngestTarget`
  - `handleIngestRequest(request, resolve): Promise<Response | null>` — `null` when the path is not an
    ingestion path, so the caller falls through.

- [ ] **Step 1: Write the failing test**

Create `packages/gatekeeper-context/__tests__/ingest-handler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  CommitOutcome, PlanOutcome, ResolveIngestTarget, StageOutcome,
} from "../src/ingest-handler.js";
import { handleIngestRequest } from "../src/ingest-handler.js";
import { sha256Hex } from "../src/ingest-manifest.js";

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
      ...(init.headers ?? {}),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: FAIL — cannot resolve `../src/ingest-handler.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/gatekeeper-context/src/ingest-handler.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: PASS — every routing, plan, upload and commit case.

- [ ] **Step 5: Run the gates and commit**

```bash
pnpm lint:check && pnpm types:check
git add packages/gatekeeper-context/src/ingest-handler.ts \
        packages/gatekeeper-context/__tests__/ingest-handler.test.ts
git commit -m "feat(context): add the plan/upload/commit ingestion routes"
```

---

### Task 4: The `push` content source, staging, and atomic commit

Adds document hashes, the staging area, the session, and the three collection methods behind the
routes — plus a Workers-pool harness, because token isolation and commit atomicity deserve real
Durable Object tests rather than mocks.

**Files:**
- Modify: `packages/gatekeeper-context/src/context-types.ts` (content variant near line 100; token types near line 131)
- Modify: `packages/gatekeeper-context/src/context-collection.ts` (record type line 72; storage schema line 88; `#assertWebWritable` line 307; the artifact replace path near line 532)
- Test: `packages/gatekeeper-context/__tests__/collection-ingest.workers.test.ts`

**Interfaces:**
- Consumes: `generateIngestToken`, `hashIngestToken`, `INGEST_TOKEN_TTL_SECONDS` from
  `./ingest-token.js`; `hashManifest`, `planUploads`, `ManifestEntry` from `./ingest-manifest.js`;
  `PlanOutcome`, `StageOutcome`, `CommitOutcome`, `StagedDocument` from `./ingest-handler.js`.
- Produces on `ContextCollectionDurableObject`: `createIngestToken()`, `listIngestTokens()`,
  `revokeIngestToken(id)`, `verifyIngestToken(token)`, `planIngest(commit, manifest, allowEmpty)`,
  `stageDocuments(sessionId, documents)`, `commitIngest(sessionId, manifest)`.
- Produces in `context-types.ts`: the `{ source: "push"; commit?; lastReceivedAt? }` variant and
  `ContextIngestTokenInfo` / `ContextIngestTokenList` / `ContextIngestTokenCreateResult`.

- [ ] **Step 1: Write the failing test**

Create `packages/gatekeeper-context/__tests__/collection-ingest.workers.test.ts`:

```ts
import { env } from "cloudflare:test";
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
    expect(documents.map(d => d.path).sort()).toEqual(["a.md", "b.md"]);
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

  it("refuses web writes to a push collection", async () => {
    await expect(collection.putContextDocument("manual.md", { description: "", body: "no" }))
      .rejects.toThrow(/read-only/);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-context && pnpm vitest run -c vitest.workers.config.ts`
Expected: FAIL — `createIngestToken` is not a function.

- [ ] **Step 3: Add the types**

In `context-types.ts`, extend `ContextCollectionContent`:

```ts
export type ContextCollectionContent =
  // Content in this collection is managed via the web UI.
  | { source: "web" }
  // Content in this collection is managed via git.
  | { source: "git"; remote: string; branch: string; lastRefreshedAt: Date; commit?: string }
  // Content in this collection is published by CI. Deliberately independent of visibility, so scoped
  // collections can use the same pipeline later.
  | { source: "push"; commit?: string; lastReceivedAt?: Date };
```

And the token types, next to the git token types:

```ts
// One live ingestion token, as shown in the management UI. Never carries the plaintext.
export type ContextIngestTokenInfo = {
  id: string;
  expiresAt: string;
};

// The collection's live ingestion tokens.
export type ContextIngestTokenList = {
  tokens: ContextIngestTokenInfo[];
};

// A freshly minted ingestion token. `plaintext` is shown once and never stored; `path` is the
// origin-relative endpoint base CI posts to, so the UI can render an absolute URL.
export type ContextIngestTokenCreateResult = {
  id: string;
  plaintext: string;
  path: string;
};
```

- [ ] **Step 4: Add storage to the Durable Object**

In `context-collection.ts`, add imports:

```ts
import type {
  CommitOutcome, PlanOutcome, StageOutcome, StagedDocument,
} from "./ingest-handler.js";
import { INGEST_TOKEN_TTL_SECONDS, generateIngestToken, hashIngestToken } from "./ingest-token.js";
import { type ManifestEntry, hashManifest, planUploads } from "./ingest-manifest.js";
```

Give `ContextRecord` a hash, and add the two new stored shapes:

```ts
type ContextRecord = {
  path: string;
  name: string;
  description: string;
  contentType: string;
  body: string;
  // SHA-256 of the raw bytes, set by CI publication. Absent on documents written before hashing
  // existed, which is why publication treats a missing hash as "must re-send".
  hash?: string;
  lastUpdated: Date;
};

// A live ingestion token. Only the hash is stored, so a storage leak yields nothing usable.
type IngestTokenRecord = {
  id: string;
  hash: string;
  createdAt: Date;
  expiresAt: Date;
};

// The open publication, if any. Deliberately small: persisting the manifest itself would reintroduce
// the per-file write amplification this protocol exists to avoid.
type IngestSession = {
  sessionId: string;
  commit: string;
  manifestHash: string;
  neededCount: number;
};
```

Add to the storage schema, alongside `documents` and `skillIndex`:

```ts
      ingestTokens: collection<IngestTokenRecord>()({ primaryKey: "id" }),
      staging: collection<ContextRecord>()({ primaryKey: "path" }),
```

and to `singletons`:

```ts
      ingestSession: <IngestSession>{ sessionId: "", commit: "", manifestHash: "", neededCount: 0 },
```

Make push collections read-only to the web path:

```ts
  #assertWebWritable(): void {
    let source = this.getMetadata().content.source;
    if (source === "git") {
      throw new Error("Git-based collections are read-only. All changes must be made through git.");
    }
    if (source === "push") {
      throw new Error("CI-published collections are read-only. All changes must be made through CI.");
    }
  }
```

- [ ] **Step 5: Add the token methods**

```ts
  // --- CI publication: tokens ---

  async createIngestToken(): Promise<ContextIngestTokenCreateResult> {
    let meta = this.getMetadata();
    if (meta.content.source !== "push") {
      throw new Error("Collection does not accept CI publication.");
    }
    let { id, plaintext } = generateIngestToken();
    let hash = await hashIngestToken(plaintext);
    let now = new Date();

    this.storage.transaction(() => {
      // Revocation deletes, but expiry alone never did, so mint time is where expired rows go.
      for (let existing of Array.from(this.storage.ingestTokens.list())) {
        if (existing.expiresAt.getTime() <= now.getTime()) {
          this.storage.ingestTokens.delete(existing.id);
        }
      }
      this.storage.ingestTokens.put({
        id, hash, createdAt: now,
        expiresAt: new Date(now.getTime() + INGEST_TOKEN_TTL_SECONDS * 1000),
      });
    });

    return {
      id,
      plaintext,
      path: `/gatekeeper/context/ingest/${encodeURIComponent(this.#domain())}/` +
          `${encodeURIComponent(meta.id)}`,
    };
  }

  async listIngestTokens(): Promise<ContextIngestTokenList> {
    let now = Date.now();
    return {
      tokens: Array.from(this.storage.ingestTokens.list())
        .filter(token => token.expiresAt.getTime() > now)
        .map(token => ({ id: token.id, expiresAt: token.expiresAt.toISOString() })),
    };
  }

  async revokeIngestToken(tokenId: string): Promise<boolean> {
    if (!this.storage.ingestTokens.get(tokenId)) return false;
    this.storage.ingestTokens.delete(tokenId);
    return true;
  }

  // Public so the handler can authenticate before reading a request body. Comparing hashes of a
  // high-entropy secret does not need a constant-time compare: a timing leak reveals a hash prefix,
  // which is useless without a preimage.
  async verifyIngestToken(plaintext: string): Promise<boolean> {
    if (!plaintext) return false;
    let hash = await hashIngestToken(plaintext);
    let now = Date.now();
    for (let record of this.storage.ingestTokens.list()) {
      if (record.hash === hash && record.expiresAt.getTime() > now) return true;
    }
    return false;
  }
```

- [ ] **Step 6: Add plan, stage and commit**

```ts
  // --- CI publication: the protocol ---

  #clearStaging(): void {
    for (let record of Array.from(this.storage.staging.list())) {
      this.storage.staging.delete(record.path);
    }
  }

  #stagedCount(): number {
    let count = 0;
    for (let _ of this.storage.staging.list()) count++;
    return count;
  }

  // Compare the desired state against what is stored and open a session for the difference.
  async planIngest(
      commit: string, manifest: ManifestEntry[], allowEmpty: boolean): Promise<PlanOutcome> {
    let meta = this.getMetadata();
    if (meta.content.source !== "push") return { status: "wrong-source" };
    if (meta.content.commit === commit) return { status: "unchanged", commit };
    if (manifest.length === 0 && !allowEmpty) return { status: "empty-refused" };

    // Await before the transaction, never inside it.
    let manifestHash = await hashManifest(manifest);

    let stored = new Map<string, string | undefined>();
    for (let record of this.storage.documents.list()) stored.set(record.path, record.hash);
    let { needed, unchanged, toDelete } = planUploads(manifest, stored);

    let sessionId = crypto.randomUUID();
    this.storage.transaction(() => {
      // A new plan supersedes any previous one, which is also how abandoned sessions get cleaned up.
      this.#clearStaging();
      this.storage.ingestSession.put({
        sessionId, commit, manifestHash, neededCount: needed.length,
      });
    });

    return { status: "planned", sessionId, needed, unchanged, toDelete: toDelete.length };
  }

  // Hold uploaded documents until commit, so a partial transfer is never visible to agents.
  async stageDocuments(sessionId: string, documents: StagedDocument[]): Promise<StageOutcome> {
    let session = this.storage.ingestSession.get();
    if (!session.sessionId || session.sessionId !== sessionId) return { status: "no-session" };

    this.storage.transaction(() => {
      for (let document of documents) this.storage.staging.put(document);
    });

    return {
      status: "staged",
      staged: documents.length,
      remaining: Math.max(0, session.neededCount - this.#stagedCount()),
    };
  }

  // Apply the publication in one transaction: upsert what was staged, delete what the manifest no
  // longer lists, record the commit, clear staging.
  async commitIngest(sessionId: string, manifest: ManifestEntry[]): Promise<CommitOutcome> {
    let session = this.storage.ingestSession.get();
    if (!session.sessionId || session.sessionId !== sessionId) return { status: "no-session" };

    // Await before the transaction, never inside it.
    if (await hashManifest(manifest) !== session.manifestHash) return { status: "manifest-mismatch" };

    let staged = Array.from(this.storage.staging.list());
    if (staged.length < session.neededCount) {
      return { status: "incomplete", missing: session.neededCount - staged.length };
    }

    // Cross-check every staged document against the committed manifest. This is the integrity gate:
    // the handler verified each body against its declared hash, and this verifies those hashes are
    // the ones the manifest actually asked for.
    let wanted = new Map(manifest.map(entry => [entry.path, entry.hash]));
    for (let document of staged) {
      if (wanted.get(document.path) !== document.hash) return { status: "manifest-mismatch" };
    }

    let added = 0;
    let updated = 0;
    let deleted = 0;

    this.storage.transaction(() => {
      for (let document of staged) {
        if (this.storage.documents.get(document.path)) updated++;
        else added++;
        this.#putDocument(document);
      }
      for (let record of Array.from(this.storage.documents.list())) {
        if (!wanted.has(record.path)) {
          this.#deleteDocument(record.path);
          deleted++;
        }
      }

      let meta = this.getMetadata();
      if (meta.content.source !== "push") throw new Error("Collection is not CI-published.");
      meta.content.commit = session.commit;
      meta.content.lastReceivedAt = new Date();
      meta.documentCount = manifest.length;
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);

      this.#clearStaging();
      this.storage.ingestSession.put({
        sessionId: "", commit: "", manifestHash: "", neededCount: 0,
      });
    });

    await this.#propagate();

    logger.info("applied a CI publication to a context collection", {
      event: "context.collection.ingest.applied",
      collectionId: this.getMetadata().id,
      commit: session.commit,
      added, updated, deleted,
    });

    return {
      status: "applied",
      commit: session.commit,
      added, updated, deleted,
      documentCount: manifest.length,
    };
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/gatekeeper-context && pnpm vitest run -c vitest.workers.config.ts`
Expected: PASS — every publication test.

Then the whole package: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: PASS — both configs.

- [ ] **Step 8: Run the gates and commit**

```bash
pnpm lint:check && pnpm types:check
git add packages/gatekeeper-context/src/context-types.ts \
        packages/gatekeeper-context/src/context-collection.ts \
        packages/gatekeeper-context/package.json \
        packages/gatekeeper-context/vitest.workers.config.ts \
        packages/gatekeeper-context/__tests__/worker.ts \
        packages/gatekeeper-context/__tests__/collection-ingest.workers.test.ts \
        pnpm-lock.yaml
git commit -m "feat(context): stage and atomically commit CI publications"
```

---

### Task 5: Management API for push collections and tokens

**Files:**
- Modify: `packages/gatekeeper-context/src/context-types.ts` (`ContextApi` interface, near line 316)
- Modify: `packages/gatekeeper-context/src/context-api.ts` (lines 126-172 and 192-208)
- Test: `packages/gatekeeper-context/__tests__/admin-gating.workers.test.ts`

**Interfaces:**
- Consumes: `createIngestToken`, `listIngestTokens`, `revokeIngestToken` from Task 4.
- Produces, on `ContextApi`:
  - `createContextCollectionIngestToken(collectionId: string): Promise<ContextIngestTokenCreateResult>`
  - `listContextCollectionIngestTokens(collectionId: string): Promise<ContextIngestTokenList>`
  - `revokeContextCollectionIngestToken(collectionId: string, tokenId: string): Promise<boolean>`
  - `createContextCollection(...)` additionally accepts `source: "push"`.

- [ ] **Step 1: Write the failing admin-gating test**

This is the task's real deliverable: proving that a global collection is admin-only. The chain being
tested already exists — `server.ts:#isAdmin()` computes it from `ADMINS`, passes it fresh per UI open
as `AppUiContext.isAdmin`, `user.ts:startAccountAppUi` forwards it, and `library-gatekeeper.ts`
constructs `ContextApiImpl` with it. These tests pin the gatekeeper end of that chain.

Create `packages/gatekeeper-context/__tests__/admin-gating.workers.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ContextApiImpl } from "../src/context-api.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";

const DOMAIN = "test-domain";

function api(accountId: string, isAdmin: boolean) {
  return new ContextApiImpl(
    env as unknown as Cloudflare.Env,
    DOMAIN,
    accountId,
    isAdmin,
    env.CONTEXT_COLLECTIONS_TEST as DurableObjectNamespace<ContextCollectionDurableObject>,
    env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>,
    env.REGISTRIES_TEST as DurableObjectNamespace<LibraryRegistryDurableObject>,
  );
}

describe("admin gating for global collections", () => {
  it("refuses to create a public collection for a non-admin", async () => {
    await expect(
      api("user-1", false).createContextCollection("Sales", "Sales knowledge.", "public", undefined, "push"),
    ).rejects.toThrow(/Admin access required/);
  });

  it("lets an admin create a public push collection with no Artifacts binding", async () => {
    let meta = await api("admin-1", true)
      .createContextCollection("Sales", "Sales knowledge.", "public", undefined, "push");
    expect(meta.visibility).toBe("public");
    expect(meta.content).toEqual({ source: "push" });
  });

  it("refuses to mint an ingestion token on a public collection for a non-admin", async () => {
    let meta = await api("admin-1", true)
      .createContextCollection("Eng", "Engineering knowledge.", "public", undefined, "push");
    await expect(api("user-1", false).createContextCollectionIngestToken(meta.id))
      .rejects.toThrow(/don't have access/);
  });

  it("lets an admin mint, list and revoke a token on a public collection", async () => {
    let admin = api("admin-1", true);
    let meta = await admin.createContextCollection("Ops", "Ops knowledge.", "public", undefined, "push");

    let token = await admin.createContextCollectionIngestToken(meta.id);
    expect(token.path).toBe(`/gatekeeper/context/ingest/${encodeURIComponent(DOMAIN)}/${meta.id}`);
    expect((await admin.listContextCollectionIngestTokens(meta.id)).tokens).toHaveLength(1);
    expect(await admin.revokeContextCollectionIngestToken(meta.id, token.id)).toBe(true);
  });

  it("still lets a non-admin own a private push collection and its token", async () => {
    // Deliberate: the admin gate is on public visibility, not on the push source, so phase 2's
    // workspace-scoped collections can use the same pipeline without reopening this decision.
    let user = api("user-2", false);
    let meta = await user.createContextCollection("Mine", "Personal notes.", "private", undefined, "push");
    let token = await user.createContextCollectionIngestToken(meta.id);
    expect(token.plaintext).toMatch(/^[0-9a-f]{32}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-context && pnpm vitest run -c vitest.workers.config.ts`
Expected: FAIL — `createContextCollectionIngestToken` is not a function, and `"push"` is rejected as an unsupported source.

- [ ] **Step 3: Add the interface methods**

In `context-types.ts`, next to the git token methods on `ContextApi`:

```ts
  createContextCollectionIngestToken(collectionId: string): Promise<ContextIngestTokenCreateResult>;
  listContextCollectionIngestTokens(collectionId: string): Promise<ContextIngestTokenList>;
  revokeContextCollectionIngestToken(collectionId: string, tokenId: string): Promise<boolean>;
```

- [ ] **Step 4: Allow creating push collections**

In `context-api.ts`, `createContextCollection`, replace the source validation and the content construction:

```ts
    if (source !== "web" && source !== "git" && source !== "push") {
      throw new Error(`Unsupported collection source: ${source}`);
    }
    if (source === "git" && !this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }
```

```ts
      content: source === "git"
        ? { source, remote: "", branch: DEFAULT_GIT_BRANCH, lastRefreshedAt: new Date() }
        : source === "push"
          ? { source }
          : { source },
```

Note the deliberate absence of an `ARTIFACTS` check for `push` — CI ingestion does not depend on Artifacts, which is the entire point.

- [ ] **Step 5: Add the token methods**

In `context-api.ts`, after the git token methods:

```ts
  async createContextCollectionIngestToken(
      collectionId: string): Promise<ContextIngestTokenCreateResult> {
    await this.#assertCanWrite(collectionId);
    return this.#collection(collectionId).createIngestToken();
  }

  async listContextCollectionIngestTokens(collectionId: string): Promise<ContextIngestTokenList> {
    await this.#assertCanWrite(collectionId);
    return this.#collection(collectionId).listIngestTokens();
  }

  async revokeContextCollectionIngestToken(
      collectionId: string, tokenId: string): Promise<boolean> {
    await this.#assertCanWrite(collectionId);
    return this.#collection(collectionId).revokeIngestToken(tokenId);
  }
```

These use `#assertCanWrite` — the same owner-or-admin check the git token methods use — and deliberately do **not** call `#assertArtifactsAvailable()`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: PASS — all five admin-gating tests plus everything from earlier tasks.

Run: `pnpm types:check`
Expected: passes. `ContextApiImpl` must satisfy `ContextApi`, so a missing method fails compilation.

- [ ] **Step 7: Commit**

```bash
pnpm lint:check
git add packages/gatekeeper-context/src/context-types.ts \
        packages/gatekeeper-context/src/context-api.ts \
        packages/gatekeeper-context/__tests__/admin-gating.workers.test.ts
git commit -m "feat(context): expose push collections and ingestion tokens on the management API"
```

---

### Task 6: Wire the endpoint into the worker

**Files:**
- Modify: `packages/gatekeeper-context/src/index.ts`
- Modify: `packages/gatekeeper-context/wrangler.jsonc`
- Modify: `packages/gatekeeper-context/src/env.d.ts`
- Modify: `scripts/release/manifest-lib.mjs`
- Modify: `scripts/testdata/` (regenerated golden manifest)

**Interfaces:**
- Consumes: `INGEST_PATH_PREFIX`, `handleIngestRequest`, `ResolveIngestTarget` from `./ingest-handler.js`; `domainName` from `./domain.js`; `ContextCollectionDurableObject` from `./context-collection.js`.
- Produces: the worker's default entrypoint now serves `POST /gatekeeper/context/ingest/<domain>/<collectionId>`.

- [ ] **Step 1: Add the rate limiter binding**

The endpoint is public and resolving a collection instantiates a Durable Object for whatever path was
requested, so it must be bounded before it faces the internet.

In `packages/gatekeeper-context/wrangler.jsonc`, above `observability`:

```jsonc
  // Bounds the public CI ingestion endpoint. Keyed per collection path, so one noisy repository
  // cannot starve the others.
  "ratelimits": [
    {
      "name": "INGEST_RATE_LIMITER",
      "namespace_id": "2001",
      "simple": { "limit": 60, "period": 60 }
    }
  ],
```

In `packages/gatekeeper-context/src/env.d.ts`, alongside `ARTIFACTS`:

```ts
    INGEST_RATE_LIMITER?: RateLimit;
```

Optional, like `ARTIFACTS`, so a deployment without the binding still works — the handler simply
skips the check.

**This also touches the release pipeline.** `scripts/release/manifest-lib.mjs` throws on any
wrangler key it does not recognise, and `ratelimits` is not in `HANDLED_CONFIG_KEYS`, so the release
build fails until it is taught about it. Add `"ratelimits"` to that set, and emit the binding
alongside the others in `buildWorkerEntry`:

```js
  for (const limiter of config.ratelimits ?? []) {
    bindings.push({
      type: "ratelimit",
      name: limiter.name,
      namespace_id: limiter.namespace_id,
      simple: limiter.simple,
    });
  }
```

Then regenerate the golden manifest and review the diff:

```bash
UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js
git diff scripts/testdata
```

Expected: the only change is a `ratelimit` binding on `gatekeeper-context`.

- [ ] **Step 2: Replace the stub default export**

The default export becomes a `WorkerEntrypoint` because the Durable Objects are reached through `ctx.exports` — this worker has no `durable_objects` binding, as `wrangler.jsonc` notes.

```ts
// Context Library worker: private per-account collections plus public per-domain collections. The
// vendor auto-provisions accounts that expose a read-only agent singleton and a management UI.

import { WorkerEntrypoint } from "cloudflare:workers";
import { INGEST_PATH_PREFIX, handleIngestRequest } from "./ingest-handler.js";
import { domainName } from "./domain.js";

export { ContextCollectionDurableObject } from "./context-collection.js";
export { UserLibraryDurableObject } from "./user-library.js";
export { LibraryRegistryDurableObject } from "./registry-do.js";
export {
  GatekeeperVendor, ContextAccount, ContextVerifier, ContextGatekeeper,
} from "./library-gatekeeper.js";

// The only HTTP surface this worker serves is CI ingestion; everything else reaches it over RPC/DOs.
// A WorkerEntrypoint rather than a plain handler, because the collection DOs are reached through
// ctx.exports (this worker declares no durable_objects binding).
export default class extends WorkerEntrypoint<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    // Bound the endpoint before resolving anything: resolving instantiates a Durable Object for
    // whatever path was requested, so an unauthenticated caller must not reach it unthrottled.
    if (new URL(request.url).pathname.startsWith(INGEST_PATH_PREFIX) && this.env.INGEST_RATE_LIMITER) {
      let { success } = await this.env.INGEST_RATE_LIMITER.limit({ key: new URL(request.url).pathname });
      if (!success) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429, headers: { "content-type": "application/json" },
        });
      }
    }

    let collections = this.ctx.exports.ContextCollectionDurableObject;
    let response = await handleIngestRequest(request, (domain, collectionId) =>
      collections.get(collections.idFromName(domainName(domain, collectionId))));
    if (response) return response;

    return new Response("Context Library worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  }
}
```

- [ ] **Step 3: Verify types**

Run: `pnpm types:check`
Expected: passes. If the DO stub type does not satisfy `IngestTarget`, the mismatch is in one of `verifyIngestToken` / `planIngest` / `stageDocuments` / `commitIngest` — align the collection with Task 3's types rather than widening them.

- [ ] **Step 4: Verify the route end to end**

Run the dev server in one terminal: `pnpm dev-server`

In another, confirm the route is reachable and rejects an unauthenticated push (replace `<port>` with the dev router's port):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:<port>/gatekeeper/context/ingest/dev/does-not-exist/plan \
  -H 'content-type: application/json' \
  -d '{"commit":"c1","manifest":[]}'
```

Expected: `401` — no bearer token, rejected before the collection is consulted.

- [ ] **Step 5: Commit**

```bash
pnpm lint:check && pnpm types:check && node --test scripts/release-manifest.test.js
git add packages/gatekeeper-context/src/index.ts \
        packages/gatekeeper-context/wrangler.jsonc \
        packages/gatekeeper-context/src/env.d.ts \
        scripts/release/manifest-lib.mjs \
        scripts/testdata
git commit -m "feat(context): serve the rate-limited CI ingestion endpoint"
```

---

### Task 7: Management UI for push collections

**Files:**
- Modify: `packages/gatekeeper-context/app/ContextLibraryPage.tsx` (source options near line 693; collection detail buttons near line 1166-1200; new modal after `GitTokenManagementModal`, which ends near line 1745)

**Interfaces:**
- Consumes: `createContextCollectionIngestToken`, `listContextCollectionIngestTokens`, `revokeContextCollectionIngestToken` from Task 5; `ContextIngestTokenCreateResult`, `ContextIngestTokenInfo` from `context-types.ts`.
- Produces: no exports consumed by later tasks.

- [ ] **Step 1: Add the source option**

In the source options array (near line 693, alongside the `"git"` entry), add:

```tsx
  {
    value: "push" as const,
    Icon: CloudArrowUp,
    title: "CI push",
    description: "Content is pushed from CI. All changes must be made in the source repository.",
  },
```

Import `CloudArrowUp` from `@phosphor-icons/react` alongside the existing icon imports. Unlike the git option, render this one **unconditionally** — it must not be gated on `supportsGitCollections`, because CI ingestion does not use Artifacts.

- [ ] **Step 2: Add the token modal**

Add `IngestTokenManagementModal` after `GitTokenManagementModal`. It follows the same shape as its
git counterpart — create button, copy-once panel, list with revoke — because operators should not
have to learn two interaction models:

```tsx
function IngestTokenManagementModal({
  open,
  collectionId,
  onClose,
}: {
  open: boolean;
  collectionId: string;
  onClose: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const toastsRef = useRef(toasts);
  const { presenting, onOpenChangeComplete } = usePresentWhileOpen(open);

  const [loadingTokens, setLoadingTokens] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  const [tokens, setTokens] = useState<ContextIngestTokenInfo[]>([]);
  const [newToken, setNewToken] = useState<ContextIngestTokenCreateResult | null>(null);

  toastsRef.current = toasts;

  useEffect(() => {
    if (open) {
      setLoadingTokens(false);
      setCreatingToken(false);
      setRevokingToken(null);
      setTokens([]);
      setNewToken(null);
    }
  }, [open]);

  const loadTokens = useCallback(async () => {
    if (!open) return;
    setLoadingTokens(true);
    try {
      const result = await context.listContextCollectionIngestTokens(collectionId);
      setTokens(result.tokens);
    } catch (err) {
      toastsRef.current.add({
        title: `Failed to load ingestion tokens: ${(err as Error).message}`, variant: "error",
      });
    } finally {
      setLoadingTokens(false);
    }
  }, [open, context, collectionId]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const handleCreate = async () => {
    setCreatingToken(true);
    try {
      const token = await context.createContextCollectionIngestToken(collectionId);
      setNewToken(token);
      await loadTokens();
      toasts.add({ title: "Ingestion token created", variant: "success" });
    } catch (err) {
      toasts.add({
        title: `Failed to create ingestion token: ${(err as Error).message}`, variant: "error",
      });
    } finally {
      setCreatingToken(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    setRevokingToken(tokenId);
    try {
      await context.revokeContextCollectionIngestToken(collectionId, tokenId);
      await loadTokens();
      toasts.add({ title: "Ingestion token revoked", variant: "success" });
    } catch (err) {
      toasts.add({
        title: `Failed to revoke ingestion token: ${(err as Error).message}`, variant: "error",
      });
    } finally {
      setRevokingToken(null);
    }
  };

  const copyToClipboard = (value: string, successTitle: string, errorTitle: string) =>
    void navigator.clipboard
      .writeText(value)
      .then(() => toasts.add({ title: successTitle, variant: "success" }))
      .catch(() => toasts.add({ title: errorTitle, variant: "error" }));

  // The API returns an origin-relative path; the UI runs on the deployment origin, so it can show
  // the absolute URL CI actually posts to.
  const endpointUrl = newToken ? new URL(newToken.path, window.location.origin).toString() : "";
  const busy = creatingToken || revokingToken !== null;

  return (
    <Dialog.Root
      open={open && presenting}
      onOpenChange={(next: boolean) => {
        if (!busy && !next) onClose();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog
        className="z-[1000]! w-[min(560px,calc(100vw-32px))]! overflow-visible bg-kumo-base p-0 top-[14%]! translate-y-0!"
        size="sm"
      >
        <ModalHeader title="Manage ingestion tokens" />

        <div className="space-y-3 px-4 py-5 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <p className="max-w-sm text-[12px] leading-4 text-kumo-subtle">
              Create a token so CI can publish this collection's content.
            </p>
            <WorkshopButton
              tone="secondary"
              className="h-8!"
              onClick={handleCreate}
              loading={creatingToken}
              disabled={busy}
            >
              Create token
            </WorkshopButton>
          </div>

          {newToken && (
            <div className="space-y-3 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-3 text-[12px] leading-5 text-kumo-subtle">
              <div>
                <div className="font-medium text-kumo-default">Token created</div>
                <p className="mt-0.5">
                  Store both values as repository secrets. The token is only shown once.
                </p>
              </div>
              <div className="space-y-2">
                <div>
                  <FieldLabel>Endpoint URL</FieldLabel>
                  <div className="mt-1 flex gap-2">
                    <input
                      readOnly
                      value={endpointUrl}
                      className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base px-2 py-1 font-mono text-[11px] text-kumo-default"
                    />
                    <WorkshopButton
                      tone="secondary"
                      className="h-8!"
                      onClick={() => copyToClipboard(endpointUrl, "Endpoint URL copied", "Failed to copy endpoint URL")}
                    >
                      Copy
                    </WorkshopButton>
                  </div>
                </div>
                <div>
                  <FieldLabel>Token</FieldLabel>
                  <div className="mt-1 flex gap-2">
                    <input
                      readOnly
                      type="password"
                      value={newToken.plaintext}
                      className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base px-2 py-1 font-mono text-[11px] text-kumo-default"
                    />
                    <WorkshopButton
                      tone="secondary"
                      className="h-8!"
                      onClick={() => copyToClipboard(newToken.plaintext, "Token copied", "Failed to copy token")}
                    >
                      Copy
                    </WorkshopButton>
                  </div>
                </div>
              </div>
              <div className="border-t border-green-500/20 pt-3">
                <div className="font-medium text-kumo-default">Configure CI push</div>
                <ol className="mt-2 list-decimal space-y-1.5 pl-4">
                  <li>Add the endpoint URL as a repository secret named CONTEXT_INGEST_URL</li>
                  <li>Add the token as a repository secret named CONTEXT_INGEST_TOKEN</li>
                  <li>Add the publish workflow from docs/context-library-ingestion.md</li>
                  <li>Merge to the default branch, or run the workflow manually, to publish</li>
                </ol>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-kumo-line bg-kumo-base">
            {loadingTokens ? (
              <div className="px-3 py-2 text-[12px] text-kumo-subtle">Loading tokens...</div>
            ) : tokens.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-kumo-subtle">No ingestion tokens yet.</div>
            ) : (
              <div className="divide-y divide-kumo-line">
                {tokens.map((token) => (
                  <div
                    key={token.id}
                    className={`flex items-center justify-between gap-3 px-3 py-2 text-[12px] ${newToken?.id === token.id ? "bg-green-500/5" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-kumo-default">{token.id}</div>
                      <div className="text-kumo-subtle">
                        expires {new Date(token.expiresAt).toLocaleDateString()}
                      </div>
                    </div>
                    <WorkshopButton
                      tone="secondary"
                      className="h-8!"
                      onClick={() => void handleRevoke(token.id)}
                      loading={revokingToken === token.id}
                      disabled={revokingToken !== null}
                    >
                      Revoke
                    </WorkshopButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <WorkshopButton tone="secondary" className="h-9!" disabled={busy} onClick={onClose}>
            Close
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
```

Add `ContextIngestTokenCreateResult` and `ContextIngestTokenInfo` to the existing type import block from
`context-types.ts` at the top of the file.

- [ ] **Step 3: Fix the two-way source assumptions**

This is the riskiest part of the task and the easiest to miss. The UI derives its behaviour from two
booleans written when `git` and `web` were the only sources, so a third variant silently falls into
the wrong branch. TypeScript cannot catch this — these are boolean expressions, not exhaustive
switches.

At line 1147, replace the single flag with explicit ones:

```tsx
  const isGit = metadata.content.source === "git";
  const isPush = metadata.content.source === "push";
  // Content managed outside the UI, whatever the mechanism.
  const isSynced = isGit || isPush;
```

Then correct each use, because most of them mean *git specifically*, not *synced*:

- Line 1166 — `{isSynced && supportsGitCollections && (` becomes `{isGit && supportsGitCollections && (`
- Line 1194 — same substitution (the "Manage git tokens" button)
- Line 1227 — `label={isSynced ? "Refreshed" : "Updated"}` becomes `label={isGit ? "Refreshed" : "Updated"}`; a push collection was last *published*, not refreshed
- Line 1235 — `{isSynced && !supportsGitCollections && (` becomes `{isGit && !supportsGitCollections && (`, so the "Git synchronization unavailable" warning never appears on a push collection

At line 2228, the negative check is the one that actually breaks things — a push collection would be
treated as editable and every write would fail server-side:

```tsx
  // Only web collections are editable here; git and push content is owned elsewhere.
  const canEditDocuments = canWrite && metadata?.content.source === "web";
```

Finally the empty-state text near line 2727 branches on `source === "git"` and otherwise offers to
create files. Add the push case so it reads "No files yet. Publish from CI." rather than inviting an
upload that cannot succeed.

- [ ] **Step 4: Show the button for push collections**

Where the detail view renders "Manage git tokens" for git collections (near line 1194), add the parallel control for push collections:

```tsx
{metadata.content.source === "push" && (
  <WorkshopButton tone="secondary" className="h-8!" onClick={onManageIngestTokens}>
    Manage ingestion tokens
  </WorkshopButton>
)}
```

Thread `onManageIngestTokens` through the same props path `onManageGitTokens` already uses.

Also update the empty-state text (near line 1273) so a push collection reads: `"This collection is empty. Push content from CI."`

- [ ] **Step 5: Verify the UI builds**

Run: `pnpm --filter @gadgets/gatekeeper-context run typecheck:app`
Expected: passes.

Then: `pnpm --filter @gadgets/gatekeeper-context run build:app`
Expected: regenerates `src/generated/app.txt`. **Do not commit that file** — it is gitignored repo-wide (`packages/gatekeeper-*/src/generated/app.txt`), tracked for no gatekeeper, and regenerated by both `build` and `types:check`.

- [ ] **Step 6: Verify by hand**

Run `pnpm dev-server`, open the Context Library UI, and confirm:
- **New collection** offers **CI push**, whether or not Artifacts is bound.
- Creating one succeeds and it shows as read-only.
- As a **non-admin** (a user not listed in `ADMINS`), the **Public** visibility option is unavailable
  and **Manage ingestion tokens** on a public collection fails. This is the admin invariant seen from
  the outside; the Task 5 tests cover it from the inside.
- **Manage ingestion tokens** mints a token, shows an absolute endpoint URL, and lists the token afterwards without the plaintext.
- A real publication works end to end. In any repository with markdown under `docs/`, using the
  publisher from Task 8:
  ```bash
  COMMIT_SHA=$(git rev-parse HEAD) \
  CONTEXT_INGEST_URL='<endpoint-url>' CONTEXT_INGEST_TOKEN='<token>' \
    node docs/examples/publish-context.mjs
  ```
  Expected: it reports how many documents it sent and finishes with a `Published N documents` line,
  and those documents appear in the UI.
- **The delta actually works.** Edit one file, commit, and run the publisher again. Expected: it sends
  exactly one document and reports the rest as unchanged. This is the property the whole protocol
  exists for — if it re-sends everything, stop and check that hashes are being stored on commit.
- Running it a third time with no changes prints "Already published" and stops.

- [ ] **Step 7: Commit**

```bash
pnpm lint:check && pnpm types:check
git add packages/gatekeeper-context/app/ContextLibraryPage.tsx
git commit -m "feat(context): manage CI push collections and ingestion tokens in the UI"
```

---

### Task 8: The publisher script and onboarding documentation

This repository is on GitLab and has no `.github/`, so the GitHub workflow ships as documentation the
department repositories copy. The publisher itself is a committed script rather than a YAML string, so
it can be run and tested directly.

**Files:**
- Create: `docs/examples/publish-context.mjs`
- Create: `docs/context-library-ingestion.md`

**Interfaces:**
- Consumes: the `plan` / `upload` / `commit` contract from Tasks 3 and 4.
- Produces: nothing consumed by code.

- [ ] **Step 1: Write the publisher**

Create `docs/examples/publish-context.mjs`:

```js
// Publishes this repository to a Context Library collection.
//
// Usage, from a repository checkout:
//   COMMIT_SHA=<sha> CONTEXT_INGEST_URL=<base> CONTEXT_INGEST_TOKEN=<token> node publish-context.mjs
//
// Only documents whose content changed are transferred: the manifest is the full desired state, and
// the server replies with the subset it lacks.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE = process.env.CONTEXT_INGEST_URL;
const TOKEN = process.env.CONTEXT_INGEST_TOKEN;
const COMMIT = process.env.COMMIT_SHA;

if (!BASE || !TOKEN || !COMMIT) {
  console.error("CONTEXT_INGEST_URL, CONTEXT_INGEST_TOKEN and COMMIT_SHA are all required.");
  process.exit(1);
}

// Stay well under the server's 5 MB request ceiling; the exact figure only affects how many
// round trips a large first publication takes.
const MAX_BATCH_BYTES = 3 * 1024 * 1024;

// An include list, not an exclude list: an exclude list has to anticipate every LICENSE, lockfile and
// CI config that would otherwise become "knowledge" an agent surfaces. Widen deliberately.
const INCLUDE = /^(docs\/.*|.*\.mdx?|.*\.markdown|.*\.txt)$/i;
const TEXT = /\.(md|mdx|markdown|txt|json|ya?ml|csv)$/i;

async function post(action, body) {
  const response = await fetch(`${BASE}/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${action} failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((path) => INCLUDE.test(path));

if (files.length === 0) {
  // Without this, the publication would be a valid instruction to delete everything.
  console.error("No files matched the include list; refusing to publish an empty manifest.");
  process.exit(1);
}

const bodies = new Map();
const hashes = new Map();
const manifest = files.map((path) => {
  const buffer = readFileSync(path);
  const hash = createHash("sha256").update(buffer).digest("hex");
  bodies.set(path, TEXT.test(path)
    ? { body: buffer.toString("utf8") }
    : { body: buffer.toString("base64"), encoding: "base64" });
  hashes.set(path, hash);
  return { path, hash };
});

const plan = await post("plan", { commit: COMMIT, manifest });
if (plan.status === "unchanged") {
  console.log(`Already published at ${plan.commit}; nothing to do.`);
  process.exit(0);
}
console.log(
  `${plan.needed.length} to send, ${plan.unchanged} unchanged, ${plan.toDelete} to delete.`);

let batch = [];
let batchBytes = 0;

async function flush() {
  if (batch.length === 0) return;
  const result = await post("upload", { sessionId: plan.sessionId, documents: batch });
  console.log(`sent ${result.staged}, ${result.remaining} remaining`);
  batch = [];
  batchBytes = 0;
}

for (const path of plan.needed) {
  const document = { path, ...bodies.get(path), hash: hashes.get(path) };
  // UTF-8 bytes, not string length: the server caps the request in bytes, and multi-byte text
  // (CJK especially) is up to 3x larger than its JS string length suggests.
  const size = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (batchBytes + size > MAX_BATCH_BYTES) await flush();
  batch.push(document);
  batchBytes += size;
}
await flush();

const applied = await post("commit", { sessionId: plan.sessionId, manifest });
console.log(
  `Published ${applied.documentCount} documents ` +
  `(+${applied.added} ~${applied.updated} -${applied.deleted}).`);
```

- [ ] **Step 2: Verify the publisher against a real repository**

The dry parts run without a server. From this repository:

```bash
COMMIT_SHA=test CONTEXT_INGEST_URL=http://localhost:9999 CONTEXT_INGEST_TOKEN=x \
  node docs/examples/publish-context.mjs
```

Expected: it fails at the `plan` request (nothing is listening), *after* hashing — which proves the
include list matched files and the manifest was built. Confirm the empty-manifest guard too:

```bash
cd /tmp && rm -rf empty-repo && mkdir empty-repo && cd empty-repo && git init -q \
  && git commit -q --allow-empty -m init
COMMIT_SHA=test CONTEXT_INGEST_URL=http://localhost:9999 CONTEXT_INGEST_TOKEN=x \
  node <path-to>/publish-context.mjs
```

Expected: exits 1 with "refusing to publish an empty manifest".

Then the real end-to-end run happens in Task 7's manual verification, against a live collection.

- [ ] **Step 3: Write the onboarding document**

Create `docs/context-library-ingestion.md`:

````markdown
# Publishing a repository to the Context Library

A repository publishes its content to the Context Library. The Library never reads GitHub, so no
GitHub credential is stored anywhere in the deployment.

Only what changed is transferred. Each publication sends a manifest of every file and its hash; the
server replies with the subset it lacks, the repository uploads just those, and a final commit applies
everything at once.

## One-time setup (deployment admin)

1. Open the Context Library UI, choose **New collection**, and pick source **CI push**.
2. Set visibility to **Public** so the collection is global.
3. Write a description saying *when to consult this collection*, not what it contains — an agent
   chooses collections by their description. "How Billing services are deployed, on-call runbooks, and
   payment-provider integration decisions" beats "Billing wiki".
4. Open **Manage ingestion tokens**, create a token, and copy the endpoint URL and token. The token is
   shown once and is valid for one year.

## One-time setup (repository)

Add two repository secrets:

- `CONTEXT_INGEST_URL` — the endpoint URL
- `CONTEXT_INGEST_TOKEN` — the token

Copy `publish-context.mjs` into the repository as `scripts/publish-context.mjs`, adjusting the
`INCLUDE` pattern to match what should become knowledge. Then add
`.github/workflows/publish-context.yml`:

```yaml
name: Publish to Context Library
on:
  push:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Publish
        env:
          CONTEXT_INGEST_URL: ${{ secrets.CONTEXT_INGEST_URL }}
          CONTEXT_INGEST_TOKEN: ${{ secrets.CONTEXT_INGEST_TOKEN }}
          COMMIT_SHA: ${{ github.sha }}
        run: node scripts/publish-context.mjs
```

There is deliberately no `workflow_dispatch` trigger. A manual run publishes whatever ref it is
pointed at, which would quietly defeat the property that only reviewed content becomes agent
knowledge. To re-publish, re-run the job for a merged commit.

## What to expect

- The job logs how many documents it sent, how many were unchanged, and how many were deleted. A
  typical merge sends one or two files regardless of how large the repository is.
- Re-running for a commit that was already published prints "Already published" and stops.
- Deletions work automatically: a file removed from the repository is absent from the manifest, so
  the commit deletes it.
- A publication matching nothing in the include list is **refused**, both locally and by the server,
  because a manifest with no entries means "delete everything".
- Agents see new content immediately; there is no polling delay.
- A `SKILL.md` file becomes an agent skill and a slash command.

## Give your pages a description

A document's description is what an agent reads to decide whether the page is worth opening, and it
is extracted **only** from YAML frontmatter — prose is never summarised. A page without frontmatter
is published with an empty description and is correspondingly harder for an agent to find.

Start each page with:

```markdown
---
description: When and why to read this page.
---
```

## Limits

| Limit | Value | On exceeding |
|---|---|---|
| Single request | 5 MB | Rejected; the publisher batches below this automatically. |
| Files per publication | 5,000 | The publication is rejected. |
| Single text document | 1.4 MB | The document is rejected by name; exclude it or split it. |
| Single binary file | ~1 MB raw | Binaries are base64-encoded before the 1.4 MB check, so ~1/3 of the budget goes to encoding overhead. |

## Before you onboard a repository

Everything published becomes readable by **every** agent user in the deployment. Review the repository
for pasted credentials and unpublished drafts first. A leaked ingestion token lets someone replace the
collection's content wholesale, and agents read the result — revoke it in the UI if that is ever a
concern.
````

- [ ] **Step 4: Commit**

```bash
git add docs/context-library-ingestion.md docs/examples/publish-context.mjs
git commit -m "docs: describe publishing a repository to the Context Library"
```

---

### Task 9: Read-session collection-set seam

Independent of ingestion, but required by the spec's "Designed for extension" section: phase 2 needs a
read session pinned to a single collection, and retrofitting that later is far more expensive than
injecting the resolver now. Do not drop this task.

Today `LibraryReadSession` reaches into the owner's library to compute its own enabled set, so the
session's authority is implicit. After this change the session is *given* the set it may reach, and
`accountId` and the user-library namespace leave the class entirely — its authority becomes explicit.

**Files:**
- Modify: `packages/gatekeeper-context/src/library-read.ts` (constructor lines 36-46; `#userLib()` lines 58-60; `#enabled()` lines 63-65)
- Modify: `packages/gatekeeper-context/src/library-gatekeeper.ts` (`#newReadSession`, lines 270-278)
- Test: `packages/gatekeeper-context/__tests__/enabled-collections.workers.test.ts`

**Interfaces:**
- Consumes: `UserLibraryDurableObject`, `domainName`, `ContextCollectionVisibility`.
- Produces:
  - `type ResolveEnabledCollections = () => Promise<Map<string, ContextCollectionVisibility>>`
  - `accountEnabledCollections(userLibraries, domain, accountId): ResolveEnabledCollections`
  - `LibraryReadSession` constructor takes `resolveEnabled` in place of `userLibraries` and `accountId`.

- [ ] **Step 1: Write the failing test**

Create `packages/gatekeeper-context/__tests__/enabled-collections.workers.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-context && pnpm vitest run -c vitest.workers.config.ts`
Expected: FAIL — `accountEnabledCollections` is not exported from `library-read.js`.

- [ ] **Step 3: Introduce the seam**

In `library-read.ts`, add the type and the default resolver above the class:

```ts
// How a session learns which collections it may reach. Injected rather than derived, so a session can
// be pinned to a subset (a workspace-scoped collection) without touching the read path.
export type ResolveEnabledCollections = () => Promise<Map<string, ContextCollectionVisibility>>;

// Default resolution: the account's own private collections plus every public collection in the
// domain — the global knowledge model.
export function accountEnabledCollections(
    userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    domain: string,
    accountId: string): ResolveEnabledCollections {
  return () => userLibraries.get(userLibraries.idFromName(domainName(domain, accountId)))
      .getEnabledCollections(domain);
}
```

Replace the `userLibraries` and `accountId` constructor parameters with `private resolveEnabled: ResolveEnabledCollections`, delete `#userLib()`, and change `#enabled()` to:

```ts
  // Computed once per session; search/list/read share it.
  #enabled(): Promise<Map<string, ContextCollectionVisibility>> {
    return (this.#enabledPromise ??= this.resolveEnabled());
  }
```

Keep `domain` — `#collection(id)` still needs it.

In `library-gatekeeper.ts`, update `#newReadSession` to supply the default resolver:

```ts
      return new LibraryReadSession(
        this.#collections(),
        accountEnabledCollections(
          this.#userLibraries(), this.ctx.props.sharingDomain, this.ctx.props.accountId),
        this.ctx.props.sharingDomain, ownedAuthorizer,
        collectionIds => this.#observers().prepareObservation(collectionIds));
```

Import `accountEnabledCollections` alongside the existing `LibraryReadSession` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @gadgets/gatekeeper-context test`
Expected: PASS — both new tests plus everything from earlier tasks.

- [ ] **Step 5: Verify nothing regressed in the agent path**

Run `pnpm dev-server`, open a workspace, and ask the agent to search the Context Library. It must
still find documents in public collections — the default resolver reproduces the previous behaviour
exactly.

- [ ] **Step 6: Commit**

```bash
pnpm lint:check && pnpm types:check
git add packages/gatekeeper-context/src/library-read.ts \
        packages/gatekeeper-context/src/library-gatekeeper.ts \
        packages/gatekeeper-context/__tests__/enabled-collections.workers.test.ts
git commit -m "refactor(context): inject the read session's enabled collection set"
```

---

### Measurement B: Search latency against a real wiki (run by the controller, not a subagent)

The spec records a known weakness: `search()` iterates every document and lowercases each body, so a
search loads an entire collection into memory and allocates a doubled copy. That has never mattered
because collections were hand-authored and tiny. Publishing 10-15 MB is what makes it matter.

This task does not fix it. It produces the number that decides whether a fix is needed, and it is the
last thing to do before onboarding departments in bulk.

**Files:**
- None committed. Record the findings in the task's review notes and, if action is needed, open a
  follow-up referencing the spec's "Retrieval cost" section.

- [ ] **Step 1: Load a realistic corpus**

Publish the pilot repository, then publish two or three more copies into separate collections so the
fan-out resembles a real deployment. Aim for the expected total (10-15 MB) across roughly a dozen
public collections.

- [ ] **Step 2: Measure**

From a workspace, ask the agent a question that forces a library search, and record from the logs or
the network panel:

- wall-clock time for a whole-library `search()`
- time for a search scoped to a single collection
- the largest collection's size and document count

- [ ] **Step 3: Decide, and write down the decision**

- **Under ~300 ms whole-library** — no action. Record the number in the spec so the next person does
  not re-derive it.
- **Slower than that, or growing with each collection** — open a follow-up for splitting document
  bodies out of the searchable rows, so `search()` reads small records and loads bodies only for the
  documents it actually returns. That change is independent of ingestion and can land on its own.

Do not skip the write-up. An unmeasured "it felt fine" is what leaves the next person re-deriving the
same question a year later.

---

## Done criteria

- `pnpm lint:check`, `pnpm types:check` and `pnpm test` all pass from the repo root.
- A `push` collection can be created in the UI with no Artifacts binding present.
- **Only an admin can create a global (public) collection or mint its ingestion token**, verified
  both by the Task 5 tests and by signing in as a non-admin in the running app.
- A token minted in the UI accepts a `curl` push and rejects a wrong or revoked token.
- Re-pushing the same commit reports `unchanged`; pushing without a deleted file removes it.
- An agent finds a pushed document via the Context Library, and a pushed `SKILL.md` appears
  as a slash command.
- The read session takes an injected collection-set resolver (Task 9), so a workspace-scoped
  session can be added in phase 2 without touching the read path.
- Task 0's measured RPC limit is recorded, and `MAX_INGEST_BODY_BYTES` sits safely below it.
- A request with an invalid token is rejected without its body being read, on all three routes.
- Editing one file in a published repository transfers exactly one document.
- An empty manifest is refused unless `allowEmpty` is set, by both the publisher and the server.
- Search latency against a realistic corpus is measured and written down (Task 10).
- `node --test scripts/release-manifest.test.js` passes with the regenerated golden manifest.
