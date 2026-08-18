// Test-only entrypoint exposing the Durable Objects to the Workers test pool, and re-exporting the
// real default export so SELF.fetch() in tests drives the production entrypoint (rate limiter,
// ctx.exports resolution, ingestion routing) rather than a stub.

export { ContextCollectionDurableObject } from "../src/context-collection.js";
export { UserLibraryDurableObject } from "../src/user-library.js";
export { LibraryRegistryDurableObject } from "../src/registry-do.js";
export { default } from "../src/index.js";
