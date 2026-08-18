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
        // Mirrors the real INGEST_RATE_LIMITER binding (see wrangler.jsonc) so the entrypoint's
        // limiter-before-resolve ordering is exercised for real, not stubbed. limit is 1 rather than
        // production's 60 so worker-entrypoint.workers.test.ts can trip it deterministically in one
        // extra request instead of sixty.
        ratelimits: {
          INGEST_RATE_LIMITER: { namespace_id: "2001", simple: { limit: 1, period: 60 } },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.workers.test.ts"],
  },
});
