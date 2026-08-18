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
