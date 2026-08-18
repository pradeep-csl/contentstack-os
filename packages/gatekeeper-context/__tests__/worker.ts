// Test-only entrypoint exposing the Durable Objects to the Workers test pool.

export { ContextCollectionDurableObject } from "../src/context-collection.js";
export { UserLibraryDurableObject } from "../src/user-library.js";
export { LibraryRegistryDurableObject } from "../src/registry-do.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("test worker");
  },
};
