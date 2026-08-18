import { configDefaults, defineConfig } from "vitest/config";

// The plain suite runs in Node, where cloudflare:test isn't available, so it must not pick up the
// Workers-pool suite's files (vitest.workers.config.ts owns __tests__/*.workers.test.ts).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.workers.test.ts"],
  },
});
