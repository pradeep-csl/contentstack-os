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
    expect(await hashManifest(entries)).toBe(await hashManifest(entries.toReversed()));
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
    expect(result.needed.toSorted()).toEqual(["changed.md", "legacy.md", "new.md"]);
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
    // extractDescription only reads the YAML-frontmatter `description`/`summary` key for markdown
    // (see description-extractors.ts); a heading-only body with no frontmatter yields "" today, same
    // as the existing git-sync path (artifact-sync.ts), so this body carries frontmatter to exercise
    // the derivation this test is named for.
    let body = "---\ndescription: How discounts work.\n---\n\n# Discount policy\n\nHow discounts work.";
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
