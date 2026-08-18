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
