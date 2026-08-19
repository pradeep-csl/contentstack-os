// Guards for the Contentstack text ramp. See
// docs/superpowers/specs/2026-08-19-type-and-contrast-remediation-design.md
//
// These tests exist because the 2026-08-06 re-skin measured #a9b6cb at 2.05:1, wrote down that it
// would become a defect if used for anything but disabled state, and deferred the audit. It was
// used for content 212 times. Computed guards, not prose, are what stop that happening again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKENS = join(ROOT, 'packages/design-tokens/tokens.css')
const KUMO_DIST = join(ROOT, 'packages/workshop-frontend/node_modules/@cloudflare/kumo/dist')

// The light palette is the first `@theme { ... }` block; the dark palette lives in a separate
// [data-mode="dark"] block and is deliberately out of scope (spec T9).
export function lightTheme() {
  const css = readFileSync(TOKENS, 'utf8')
  const open = css.indexOf('@theme {')
  const body = css.slice(open, css.indexOf('\n}', open))
  const map = new Map()
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    map.set(name, value.trim())
  }
  return map
}

function kumoFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) kumoFiles(full, out)
    else if (/\.(css|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

test('every Kumo text token that Kumo references is given a Contentstack value', () => {
  const referenced = new Set()
  for (const file of kumoFiles(KUMO_DIST)) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/--(text-color-kumo-[a-z-]+)/g)) {
      referenced.add(`--${name}`)
    }
  }
  const declared = lightTheme()
  const missing = [...referenced].filter((t) => !declared.has(t)).toSorted()
  assert.deepEqual(missing, [], 'declare these in packages/design-tokens/tokens.css')
})

const channel = (c) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Text that carries meaning. Every one of these must be readable on every surface it can land on.
const CONTENT_TOKENS = [
  '--text-color-kumo-strong',
  '--text-color-kumo-default',
  '--text-color-kumo-subtle',
  '--text-color-kumo-link',
  '--text-color-kumo-brand',
  '--text-color-kumo-danger',
  '--text-color-kumo-success',
  '--text-color-kumo-warning',
  '--text-color-kumo-info',
]

test('every content text token clears WCAG AA on every light surface', () => {
  const theme = lightTheme()
  const surfaces = [
    ['base', '#ffffff'],
    ['elevated', theme.get('--color-kumo-elevated')],
    ['tint', theme.get('--color-kumo-tint')],
  ]
  const failures = []
  for (const token of CONTENT_TOKENS) {
    const value = theme.get(token)
    assert.match(value, /^#[0-9a-f]{6}$/i, `${token} must be a 6-digit hex to be checked`)
    for (const [label, surface] of surfaces) {
      const ratio = contrast(value, surface)
      if (ratio < 4.5) failures.push(`${token} on ${label}: ${ratio.toFixed(2)}`)
    }
  }
  assert.deepEqual(failures, [], 'these fail AA as body text')
})

// The inverse guard. `inactive` marks a control the user cannot operate; if it becomes readable it
// stops communicating that, and content starts being written in it again — which is the exact
// regression this whole change is remediating.
test('inactive stays below AA, so it cannot be reused for content', () => {
  const value = lightTheme().get('--text-color-kumo-inactive')
  const ratio = contrast(value, '#ffffff')
  assert.ok(ratio < 4.5, `inactive is ${ratio.toFixed(2)}:1 — too readable to mean "disabled"`)
})

test('placeholder clears AA on the surfaces placeholders actually occupy', () => {
  const theme = lightTheme()
  for (const surface of ['#ffffff', theme.get('--color-kumo-elevated')]) {
    const ratio = contrast(theme.get('--text-color-kumo-placeholder'), surface)
    assert.ok(ratio >= 4.5, `placeholder on ${surface} is ${ratio.toFixed(2)}:1`)
  }
})

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-app', '.wrangler', 'generated', 'build', '.git'])

function tsxFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) tsxFiles(full, out)
    else if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const repoPath = (file) => relative(ROOT, file).split(sep).join('/')

// `inactive` is 2.48:1: the colour of a control the user cannot operate. It is legitimate only
// when the style is scoped to a disabled state, wherever `disabled:`/`group-disabled:`/
// `peer-disabled:` sits in the variant chain (either order, any chain length). A bare
// `text-kumo-inactive` is content at 2.48:1, which is the defect this guard exists to prevent —
// it was used that way 212 times. No allowlist: every occurrence must justify itself on its own
// class string.
//
// A single negative-lookbehind regex can only see the one variant immediately adjacent to the
// class name, so `disabled:hover:text-kumo-inactive` (disabled earlier in the chain, not
// adjacent) was misclassified as bare by an earlier version of this guard. Instead, capture the
// whole utility token — its full variant chain plus the class name — and search that chain for
// `disabled:` (optionally `group-`/`peer-`-prefixed) anywhere in it.
const INACTIVE_TOKEN = /[\w:[\]./-]*\btext-kumo-inactive\b/g
const DISABLED_VARIANT = /(?:^|:)(?:group-|peer-)?disabled:/

function bareInactiveIn(text) {
  for (const [token] of text.matchAll(INACTIVE_TOKEN)) {
    if (!DISABLED_VARIANT.test(token)) return true
  }
  return false
}

// Table-driven proof for the classifier itself, independent of the current state of the tree —
// the file scan below passes vacuously once the tree is clean, so this is what actually stops the
// next person from silently breaking the regex.
const INACTIVE_TOKEN_CASES = [
  ['text-kumo-inactive', true],
  ['disabled:text-kumo-inactive', false],
  ['group-disabled:text-kumo-inactive', false],
  ['peer-disabled:text-kumo-inactive', false],
  ['md:disabled:text-kumo-inactive', false],
  ['hover:text-kumo-inactive', true],
  ['hover:disabled:text-kumo-inactive', false],
  ['disabled:hover:text-kumo-inactive', false],
]

test('the inactive classifier scopes disabled: correctly in either variant order', () => {
  for (const [token, wantBare] of INACTIVE_TOKEN_CASES) {
    assert.equal(bareInactiveIn(token), wantBare, `${token}: expected bare=${wantBare}`)
  }
})

test('text-kumo-inactive is only ever scoped to a disabled state', () => {
  const offenders = []
  for (const file of tsxFiles(join(ROOT, 'packages/workshop-frontend/src'))) {
    if (bareInactiveIn(readFileSync(file, 'utf8'))) offenders.push(repoPath(file))
  }
  assert.deepEqual(offenders, [], 'use text-kumo-subtle for content, or scope it with disabled:')
})

// Sizing must come from the text-ui-* scale. Bans ad-hoc pixel literals, Tailwind's bare names
// (which belong to Kumo's compiled components now — see the --text-* note in styles.css), px
// letter-spacing, and the named `tracking-tight`/`tracking-tighter` utilities.
// The named negative-tracking ban is unconditional, not size-gated like the px form: the scale
// already supplies letter-spacing at every step where negative tracking belongs (xl -0.01em,
// 2xl -0.015em, 3xl -0.02em), so a spot override — bracket or named — is exactly the ad-hoc
// pattern this plan removes. If a heading genuinely needs tighter tracking, change the scale,
// don't override it at one call site.
// Everything left here still carries a 7b item: `text-[13px]`/`text-[20px]`/`text-base`/`text-xl`/
// `text-2xl`/`text-3xl` (per-element judgement), a `leading-*`/`tracking-normal|wide|wider`
// collision, or a deferred px-tracking site (size 17px+, or a non-standard decimal size this
// codemod's mapping table doesn't cover, e.g. `text-[11.5px]`/`text-[12.5px]`).
const PENDING_SIZES = new Set([
  'packages/workshop-frontend/src/AdminPage.tsx',
  'packages/workshop-frontend/src/BlueprintLandingPage.tsx',
  'packages/workshop-frontend/src/BlueprintModal.tsx',
  'packages/workshop-frontend/src/FileSidebar.tsx',
  'packages/workshop-frontend/src/GadgetEditor.tsx',
  'packages/workshop-frontend/src/GadgetUI.tsx',
  'packages/workshop-frontend/src/LoginPage.tsx',
  'packages/workshop-frontend/src/ShareModal.tsx',
  'packages/workshop-frontend/src/WorkpiecePicker.tsx',
  'packages/workshop-frontend/src/components/AppShell/CommandPalette.tsx',
  'packages/workshop-frontend/src/components/AppShell/SidebarItem.tsx',
  'packages/workshop-frontend/src/components/EmptyState.tsx',
  'packages/workshop-frontend/src/components/SectionEyebrow.tsx',
  'packages/workshop-frontend/src/components/chat/SlashCommandPicker.tsx',
  'packages/workshop-frontend/src/components/format/NewFormatRow.tsx',
  'packages/workshop-frontend/src/routes/blueprints.tsx',
  'packages/workshop-frontend/src/routes/gatekeepers.tsx',
  'packages/workshop-frontend/src/routes/index.tsx',
  'packages/workshop-frontend/src/routes/outputs.tsx',
  'packages/workshop-frontend/src/routes/workspaces.tsx',
])

// `[\d.]+`, not `\d+`: a bare `\d+` misses decimal literals like `text-[11.5px]`, which is a real,
// distinct ad-hoc size in this tree (21 sites) and not one the mapping table below has an answer
// for — it must still be caught so it lands in PENDING_SIZES rather than passing silently.
const BANNED_SIZE = /\btext-\[[\d.]+px\]|\btext-(?:xs|sm|base|lg|xl|2xl|3xl)\b/
// The named forms are unconditional (see the comment above PENDING_SIZES): tracking-tight and
// tracking-tighter are negative letter-spacing exactly like tracking-[-0.35px] is, just spelled
// with a keyword instead of a bracket — the guard has to catch both or a named override sails
// through unnoticed, which is exactly what happened at Header.tsx.
const BANNED_TRACKING = /\btracking-\[-?[\d.]+px\]|\btracking-tight(?:er)?\b/

// Table-driven proof that the regex targets the old scale and leaves the new one alone —
// verified before the codemod runs, since a guard that flags the state being migrated toward
// would send the migration in circles.
const BANNED_SIZE_CASES = [
  ['text-[13px]', true],
  ['text-[11.5px]', true],
  ['text-sm', true],
  ['text-ui-xs', false],
  ['text-ui-sm', false],
  ['text-ui-md', false],
  ['text-ui-lg', false],
  ['text-ui-xl', false],
  ['text-ui-2xl', false],
  ['text-ui-3xl', false],
]

test('BANNED_SIZE flags the old scale and leaves text-ui-* alone', () => {
  for (const [token, wantBanned] of BANNED_SIZE_CASES) {
    assert.equal(BANNED_SIZE.test(token), wantBanned, `${token}: expected banned=${wantBanned}`)
  }
})

const BANNED_TRACKING_CASES = [
  ['tracking-[-0.25px]', true],
  ['tracking-[0.3px]', true],
  ['tracking-tight', true],
  ['tracking-tighter', true],
  ['tracking-normal', false],
  ['tracking-wide', false],
  ['tracking-wider', false],
  ['tracking-widest', false],
]

test('BANNED_TRACKING flags px letter-spacing and named negative tracking', () => {
  for (const [token, wantBanned] of BANNED_TRACKING_CASES) {
    assert.equal(BANNED_TRACKING.test(token), wantBanned, `${token}: expected banned=${wantBanned}`)
  }
})

// `text-ui-2xs` is the one step in the scale that bakes in its own letter-spacing
// (+0.06em). A sibling `tracking-*` utility on the same line has equal specificity and
// wins on source order, silently overriding it — which is exactly what happened when a
// PX-TRACK cleanup swapped a px bracket for the named `tracking-wide` (0.025em) without
// checking it against the token's own value, undoing more than half the intended spacing.
//
// Scoped to the named keywords, not `tracking-[Nem]` brackets: those are a separate,
// much wider pre-existing convention (dozens of sites, most spelling out the scale's own
// 0.06em explicitly) that predates this remediation and is out of its scope. The named
// forms are the failure mode that actually occurred — a spot override that reads as
// harmless but silently wins.
const TWOXS_TOKEN = /\btext-ui-2xs\b/
const NAMED_TRACKING = /\btracking-(?:tight|tighter|normal|wide|wider|widest)\b/

function has2xsNamedTrackingCollision(line) {
  return TWOXS_TOKEN.test(line) && NAMED_TRACKING.test(line)
}

const TWOXS_TRACKING_CASES = [
  ['text-ui-2xs font-semibold uppercase tracking-wide text-kumo-subtle', true],
  ['text-ui-2xs font-semibold uppercase tracking-wider text-kumo-subtle', true],
  ['text-ui-2xs font-semibold uppercase tracking-normal text-kumo-subtle', true],
  ['text-ui-xs font-semibold uppercase tracking-wider text-kumo-subtle', false],
  ['text-ui-2xs font-semibold uppercase text-kumo-subtle', false],
  ['text-ui-2xs font-semibold uppercase tracking-[0.06em] text-kumo-subtle', false],
]

test('the 2xs/tracking classifier flags only text-ui-2xs lines carrying a named tracking utility', () => {
  for (const [line, want] of TWOXS_TRACKING_CASES) {
    assert.equal(has2xsNamedTrackingCollision(line), want, `${line}: expected ${want}`)
  }
})

test('text-ui-2xs never shares a line with a named tracking-* utility', () => {
  const offenders = []
  for (const file of tsxFiles(join(ROOT, 'packages/workshop-frontend/src'))) {
    const rel = repoPath(file)
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (has2xsNamedTrackingCollision(line)) offenders.push(`${rel}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], 'text-ui-2xs already supplies +0.06em — delete the tracking-* override')
})

test('sizing comes from the text-ui-* scale outside the pending allowlist', () => {
  const offenders = []
  for (const file of tsxFiles(join(ROOT, 'packages/workshop-frontend/src'))) {
    const rel = repoPath(file)
    if (PENDING_SIZES.has(rel)) continue
    const text = readFileSync(file, 'utf8')
    const hits = []
    if (BANNED_SIZE.test(text)) hits.push('ad-hoc or Tailwind size')
    if (BANNED_TRACKING.test(text)) hits.push('px letter-spacing')
    if (hits.length) offenders.push(`${rel}: ${hits.join(', ')}`)
  }
  assert.deepEqual(offenders, [], 'migrate to text-ui-*, or add to PENDING_SIZES')
})

test('the sizes allowlist has no stale entries', () => {
  const stale = [...PENDING_SIZES].filter((rel) => {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    return !BANNED_SIZE.test(text) && !BANNED_TRACKING.test(text)
  })
  assert.deepEqual(stale, [], 'these are clean — remove them from PENDING_SIZES')
})
