// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // Public-collections snapshot KV.
    CONTEXT_COLLECTIONS: KVNamespace;
    // Optional Git-compatible backing repos for artifact-backed context collections.
    ARTIFACTS?: Artifacts;
    // Optional: bounds the public CI ingestion endpoint. Absent means the check is skipped.
    INGEST_RATE_LIMITER?: RateLimit;
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
