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
