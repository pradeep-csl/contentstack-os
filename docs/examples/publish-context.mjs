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
// Assumes matched files are valid UTF-8. A file that isn't will be lossily re-encoded by
// buffer.toString("utf8") below, so its uploaded body won't match the hash computed from the raw
// buffer; the server rejects it as a named "hash-mismatch" rather than silently corrupting it.
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
  // The server's cap is on UTF-8 bytes on the wire, not JS string length: a plain .length here would
  // undercount multi-byte content (e.g. CJK text) by up to 3x and could send a batch that's well past
  // MAX_BATCH_BYTES on the wire while still believing it was under it.
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
