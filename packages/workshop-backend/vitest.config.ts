import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
 * tests import modules directly; the main Worker and a test-only SQLite DO binding support the
 * Overseer cost-persistence integration test without loading the full deployment configuration.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: './src/server.ts',
      miniflare: {
        compatibilityDate: '2026-02-02',
        compatibilityFlags: ['experimental', 'nodejs_compat'],
        // Session expiry is env-driven and off by default; the suite sets it so the expiry path is
        // exercised. Tests that create a session and use it immediately are unaffected.
        bindings: { SESSION_MAX_AGE_HOURS: '24' },
        durableObjects: {
          TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
          TEST_USER: { className: 'UserDurableObject', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ['../../scripts/assert-workerd.ts'],
  },
})
