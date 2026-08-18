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
      },
    }),
  ],
  test: {
    include: ["__tests__/*.workers.test.ts"],
  },
});
