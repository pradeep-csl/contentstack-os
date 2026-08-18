// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // Public-collections snapshot KV.
    CONTEXT_COLLECTIONS: KVNamespace;
    // Optional Git-compatible backing repos for artifact-backed context collections.
    ARTIFACTS?: Artifacts;
    // Optional: bounds the public CI ingestion endpoint per collection. Absent means the check is
    // skipped.
    INGEST_RATE_LIMITER?: RateLimit;
    // Optional: the whole endpoint's ceiling, which the per-collection key cannot provide — it bounds
    // a caller walking collection ids. Absent means the check is skipped.
    INGEST_GLOBAL_RATE_LIMITER?: RateLimit;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./index.js");
    // Storage classes exposed as DO namespaces on ctx.exports.
    durableNamespaces:
      | "ContextCollectionDurableObject"
      | "UserLibraryDurableObject"
      | "LibraryRegistryDurableObject"
      | "ContextGatekeeper";
  }
}
