// Ratchet guard for the Contentstack design-system migration.
//
// LEGACY holds values from the Cloudflare-era palette: brand orange (hex and the raw rgb() form
// of its focus glow), the warm neutral surface ramp, the warm Monaco/diff colours, the old dark
// palette, and the old category colours. Any source file still containing one must be listed in
// PENDING. As each file is converted it is removed from PENDING, and the second test below fails
// if a PENDING entry no longer needs to be there — so the list can only shrink. Walks the whole
// repo (not just packages/) over ts/tsx/css/html/mjs/js/jsx/svg files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const LEGACY = [
  // Brand orange and its derived shades.
  '#ff4801', '#e03f00', '#b84e00', '#a54200', '#ff8a5c', '#ff7038',
  '#ff500a', '#ffe9e0', '#ffa683', '#b13200',
  // Warm neutral surface ramp.
  '#fcfcfb', '#f8f8f7', '#f3f3f1', '#efeeec', '#e8e7e4', '#dededb',
  '#cac8c3', '#14110f', '#1c1a18', '#100f0d', '#f1f0ee',
  // Warm code-surface palette (Monaco + diff viewer).
  '#fffdfb', '#1f1d1a', '#a39990', '#b56a1f', '#6b6157',
  '#c9beb1', '#f3eadf', '#faf4ee',
  // Old dark palette.
  '#16151f', '#4b3d66', '#352f4a', '#2a263b', '#423a5f', '#332d4d', '#11101a',
  // Old category colours.
  '#0a95ff', '#ee0ddb', '#19e306', '#9616ff',
  '#14111014',
  // Old CodeMirror/diff colours.
  '#8e3aa6', '#4d8a44', '#3a72c9', '#c14438', '#d8b4fe', '#86efac',
  '#fbbf24', '#93c5fd', '#fca5a5', '#e8e6f0', '#bdb7ae', '#b3d4ff',
  // Cloudflare-orange focus glow, non-hex forms.
  'rgb(255 106 0', 'rgb(255, 106, 0',
  // Cloudflare-era typefaces. Named in --font-sans/--font-mono but never licensed, shipped or
  // loaded, so the product silently rendered in the system fallback.
  'ft kunst grotesk', 'apercu mono pro',
]

// Build output and committed data blobs are not sources.
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-app', '.wrangler', 'generated',
  'build', 'format-blueprints', '.git', '.superpowers', 'docs',
])
const SOURCE_EXT = /\.(ts|tsx|css|html|mjs|js|jsx|svg)$/

// Files not yet migrated. Remove an entry in the task that converts it.
const PENDING = new Set([
  // This file's own LEGACY array has to contain the legacy hex literals it's checking for.
  'scripts/legacy-palette.test.js',
  // Cloudflare-era typefaces newly added to LEGACY by the workshop-frontend font migration. These
  // are separate, self-contained UI stacks outside that task's scope (gatekeeper app bundles and
  // the MCP connect-page palette copied from workshop-frontend/src/styles.css) — not yet migrated.
  'packages/gatekeeper-context/app/styles.css',
  'packages/gatekeeper-scheduler/app/styles.css',
  'packages/mcp-shared/src/html.ts',
])

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (SOURCE_EXT.test(entry.name)) out.push(full)
  }
  return out
}

const repoPath = (file) => relative(ROOT, file).split(sep).join('/')
const legacyHits = (text) => LEGACY.filter((hex) => text.includes(hex))

test('no legacy Cloudflare palette colours outside the pending allowlist', () => {
  const offenders = []
  for (const file of sourceFiles(ROOT)) {
    const rel = repoPath(file)
    if (PENDING.has(rel)) continue
    const hits = legacyHits(readFileSync(file, 'utf8').toLowerCase())
    if (hits.length) offenders.push(`${rel}: ${hits.join(', ')}`)
  }
  assert.deepEqual(offenders, [], 'convert these files or add them to PENDING')
})

test('the pending allowlist has no stale entries', () => {
  const stale = []
  for (const rel of PENDING) {
    const path = join(ROOT, rel)
    if (!existsSync(path)) {
      stale.push(rel)
      continue
    }
    const hits = legacyHits(readFileSync(path, 'utf8').toLowerCase())
    if (!hits.length) stale.push(rel)
  }
  assert.deepEqual(stale, [], 'these files are clean — remove them from PENDING')
})
