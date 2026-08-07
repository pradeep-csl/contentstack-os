// Ratchet guard for the Contentstack design-system migration.
//
// LEGACY holds hex values from the Cloudflare-era palette (brand orange, the warm neutral
// surface ramp, and the warm Monaco/diff colours). Any source file still containing one must
// be listed in PENDING. As each file is converted it is removed from PENDING, and the second
// test below fails if a PENDING entry no longer needs to be there — so the list can only shrink.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = join(ROOT, 'packages')

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
]

// Build output and committed data blobs are not sources.
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-app', '.wrangler', 'generated',
  'build', 'format-blueprints', '.git',
])
const SOURCE_EXT = /\.(ts|tsx|css|html)$/

// Files not yet migrated. Remove an entry in the task that converts it.
const PENDING = new Set([
  'packages/gatekeeper-context/app/ContextLibraryPage.tsx',
  'packages/gatekeeper-context/app/index.html',
  'packages/gatekeeper-scheduler/app/index.html',
  'packages/mcp-shared/src/html.ts',
  'packages/workshop-frontend/src/CodeDiffEditor.css',
  'packages/workshop-frontend/src/components/monacoTheme.ts',
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
  for (const file of sourceFiles(PACKAGES)) {
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
