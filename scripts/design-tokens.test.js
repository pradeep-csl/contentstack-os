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

function referencedKumoTokens() {
  const referenced = new Set()
  for (const file of kumoFiles(KUMO_DIST)) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/--((?:text-)?color-kumo-[a-z-]+)/g)) {
      referenced.add(`--${name}`)
    }
  }
  return referenced
}

// Kumo's compiled `dist/` doesn't only reference `--text-color-kumo-*` (content text): it also
// references bare `--color-kumo-*` (surfaces, fills, badges, banners, focus rings, hairlines) that
// this same completeness guard used to miss entirely. Two were live defects — `--color-kumo-hairline`
// and `--color-kumo-focus` are now declared in tokens.css — and the rest are real but not yet
// audited. Rather than declare 26+ values blind, they're recorded here so the guard still catches
// anything *new* that Kumo starts consuming, without pretending the backlog is closed.
//
// Note: `[a-z-]+` doesn't match digits, so the twelve-plus `--color-kumo-neutral-<n>` variants all
// collapse into the single captured name `--color-kumo-neutral-` (matching stops at the first
// digit). That's fine here — one allowlist entry still covers the whole family.
const PENDING_KUMO_TOKENS = new Set([
  '--color-kumo-badge-blue',
  '--color-kumo-badge-green',
  '--color-kumo-badge-inverted',
  '--color-kumo-badge-neutral',
  '--color-kumo-badge-orange',
  '--color-kumo-badge-purple',
  '--color-kumo-badge-red',
  '--color-kumo-badge-teal',
  '--color-kumo-banner-info',
  '--color-kumo-banner-warning',
  '--color-kumo-canvas',
  '--color-kumo-neutral-',
  '--color-kumo-shadow-drop',
  '--color-kumo-shadow-edge',
])

test('every Kumo text token that Kumo references is given a Contentstack value', () => {
  const declared = lightTheme()
  const missing = [...referencedKumoTokens()]
    .filter((t) => !declared.has(t) && !PENDING_KUMO_TOKENS.has(t))
    .toSorted()
  assert.deepEqual(missing, [], 'declare these in packages/design-tokens/tokens.css')
})

// Same ratchet shape as PENDING_SIZES: an allowlist entry that Kumo no longer references, or that
// tokens.css now declares, is stale and must be removed rather than left to rot.
test('the pending Kumo tokens allowlist has no stale entries', () => {
  const declared = lightTheme()
  const referenced = referencedKumoTokens()
  const stale = [...PENDING_KUMO_TOKENS].filter(
    (t) => declared.has(t) || !referenced.has(t),
  )
  assert.deepEqual(stale, [], 'these are declared or no longer referenced — remove them from PENDING_KUMO_TOKENS')
})

// Contrast value assertions (content tokens clear AA, `inactive` stays below AA, placeholder on
// its real surfaces) live in packages/workshop-frontend/src/designTokens.test.ts, which already
// carries a WCAG implementation for both light and dark palettes. This file scans the source tree;
// it does not re-implement contrast maths (see ruling R23 in task-9-brief.md).

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

// `gatekeeper-context/app` and `gatekeeper-scheduler/app` import the same `packages/design-tokens/
// tokens.css` as workshop-frontend, so they inherited the retuned Kumo text ramp — but until now
// these three scans only walked `packages/workshop-frontend/src`, so 31 bare `text-kumo-inactive`
// content uses in those two app bundles went undetected. The inactive-scope and 2xs/tracking guards
// below apply unconditionally now that the fix has landed. `text-ui-*` doesn't exist outside
// workshop-frontend (see styles.css), so the sizing guard alone needs a pending allowlist for these
// two packages' pre-existing ad-hoc debt (~75 px sizes, 48 negative px trackings, 4 tracking-tight)
// — recorded, not migrated, since there's no scale here to migrate onto.
const SCAN_DIRS = [
  join(ROOT, 'packages/workshop-frontend/src'),
  join(ROOT, 'packages/gatekeeper-context/app'),
  join(ROOT, 'packages/gatekeeper-scheduler/app'),
]

function allScanFiles() {
  return SCAN_DIRS.flatMap((dir) => tsxFiles(dir))
}

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
//
// `!` is in the character class too: Tailwind's important-modifier prefix (`disabled:!text-kumo-
// inactive`) sits between the last `:` and the class name, and without it here the leading
// `disabled:` variant falls outside the captured token — exactly the false-bare misclassification
// this guard exists to avoid, just one character earlier than the original bug.
const INACTIVE_TOKEN = /[\w:[\]./!-]*\btext-kumo-inactive\b/g
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
  ['disabled:!text-kumo-inactive', false],
]

test('the inactive classifier scopes disabled: correctly in either variant order', () => {
  for (const [token, wantBare] of INACTIVE_TOKEN_CASES) {
    assert.equal(bareInactiveIn(token), wantBare, `${token}: expected bare=${wantBare}`)
  }
})

test('text-kumo-inactive is only ever scoped to a disabled state', () => {
  const offenders = []
  for (const file of allScanFiles()) {
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
const PENDING_SIZES = new Set([])

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
// Covers both named keywords and `tracking-[…]` brackets — including ones that merely
// restate the step's own 0.06em. There is no such thing as a harmless override here: a
// bracket that agrees with the token is dead weight, and one that disagrees (0.08em, 0.4px,
// 0.9px, 0.02em, 0.04em have all shown up) silently wins on source order exactly like the
// named form does. An earlier version of this guard excluded brackets on the theory that the
// wide pre-existing convention of spelling out 0.06em explicitly was a separate, out-of-scope
// concern — but a convention of restating a token's own default in 26 places is exactly the
// ad-hoc override this remediation exists to remove, so that exclusion no longer applies.
const TWOXS_TOKEN = /\btext-ui-2xs\b/
const TRACKING_UTILITY = /\btracking-\[[^\]]+\]|\btracking-(?:tight|tighter|normal|wide|wider|widest)\b/

function has2xsTrackingCollision(line) {
  return TWOXS_TOKEN.test(line) && TRACKING_UTILITY.test(line)
}

const TWOXS_TRACKING_CASES = [
  ['text-ui-2xs font-semibold uppercase tracking-wide text-kumo-subtle', true],
  ['text-ui-2xs font-semibold uppercase tracking-wider text-kumo-subtle', true],
  ['text-ui-2xs font-semibold uppercase tracking-normal text-kumo-subtle', true],
  ['text-ui-2xs font-semibold uppercase tracking-[0.08em] text-kumo-subtle', true],
  ['text-ui-2xs font-semibold uppercase tracking-[0.06em] text-kumo-subtle', true],
  ['text-ui-xs font-semibold uppercase tracking-wider text-kumo-subtle', false],
  ['text-ui-xs font-semibold uppercase tracking-[0.08em] text-kumo-subtle', false],
  ['text-ui-2xs font-semibold uppercase text-kumo-subtle', false],
]

test('the 2xs/tracking classifier flags text-ui-2xs lines carrying any tracking utility, named or bracketed', () => {
  for (const [line, want] of TWOXS_TRACKING_CASES) {
    assert.equal(has2xsTrackingCollision(line), want, `${line}: expected ${want}`)
  }
})

test('text-ui-2xs never shares a line with a tracking-* utility', () => {
  const offenders = []
  for (const file of allScanFiles()) {
    const rel = repoPath(file)
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (has2xsTrackingCollision(line)) offenders.push(`${rel}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], 'text-ui-2xs already supplies +0.06em — delete the tracking-* override')
})

// Same mechanism, same fix, different axis: `text-ui-2xs` also bakes in its own font-weight
// (600). A sibling `font-*` utility has equal specificity and wins on source order, silently
// overriding it — 34 sites carried `font-medium` (500) and 3 `font-normal` (400), undoing the
// token's weight; 19 `font-semibold` and 1 `font-bold` merely restated or exceeded it, which is
// dead weight for the same reason a restated tracking bracket is. One policy, not two: if a
// heading genuinely needs a different weight, change the scale step, don't override it per line.
const WEIGHT_UTILITY = /\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/

function has2xsWeightCollision(line) {
  return TWOXS_TOKEN.test(line) && WEIGHT_UTILITY.test(line)
}

const TWOXS_WEIGHT_CASES = [
  ['text-ui-2xs font-medium uppercase text-kumo-subtle', true],
  ['text-ui-2xs font-semibold uppercase text-kumo-subtle', true],
  ['text-ui-2xs font-normal uppercase text-kumo-subtle', true],
  ['text-ui-2xs font-bold uppercase text-kumo-subtle', true],
  ['text-ui-xs font-medium uppercase text-kumo-subtle', false],
  ['text-ui-2xs uppercase text-kumo-subtle', false],
]

test('the 2xs/weight classifier flags text-ui-2xs lines carrying any font-weight utility', () => {
  for (const [line, want] of TWOXS_WEIGHT_CASES) {
    assert.equal(has2xsWeightCollision(line), want, `${line}: expected ${want}`)
  }
})

test('text-ui-2xs never shares a line with a font-weight utility', () => {
  const offenders = []
  for (const file of tsxFiles(join(ROOT, 'packages/workshop-frontend/src'))) {
    const rel = repoPath(file)
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (has2xsWeightCollision(line)) offenders.push(`${rel}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], 'text-ui-2xs already supplies weight 600 — delete the font-* override')
})

// The heading steps of the scale (3xl page titles, 2xl section headings) exist to carry the
// `strong` text role — that's the whole point of having a bigger step. A heading sized `text-ui-3xl`
// or `text-ui-2xl` but left at `text-kumo-default` (or any other text-color) is a heading that reads
// like body copy: the exact gap a whole-branch review found at 21 of the 26 headings this scale
// step touches. Same shape as the 2xs/tracking guard above: catch the omission on the line itself
// rather than trusting convention.
const HEADING_STEP = /\btext-ui-(?:3xl|2xl)\b/
const STRONG_ROLE = /\btext-kumo-strong\b/

function missingStrongRole(line) {
  return HEADING_STEP.test(line) && !STRONG_ROLE.test(line)
}

const HEADING_STEP_CASES = [
  ['text-ui-3xl font-semibold text-kumo-strong', false],
  ['text-ui-3xl font-semibold text-kumo-default', true],
  ['text-ui-2xl leading-7 font-semibold text-kumo-strong', false],
  ['text-ui-2xl leading-7 font-semibold text-kumo-default', true],
  ['text-ui-xl leading-6 font-medium text-kumo-default', false],
  ['text-ui-md text-kumo-subtle', false],
]

test('the heading-role classifier flags text-ui-3xl/2xl lines missing text-kumo-strong', () => {
  for (const [line, want] of HEADING_STEP_CASES) {
    assert.equal(missingStrongRole(line), want, `${line}: expected ${want}`)
  }
})

test('every text-ui-3xl/2xl heading carries the text-kumo-strong role', () => {
  const offenders = []
  for (const file of tsxFiles(join(ROOT, 'packages/workshop-frontend/src'))) {
    const rel = repoPath(file)
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (missingStrongRole(line)) offenders.push(`${rel}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], 'a text-ui-3xl/2xl heading should carry text-kumo-strong')
})

// `gatekeeper-context/app` and `gatekeeper-scheduler/app` have no `text-ui-*` scale to migrate onto
// (it's defined only in `workshop-frontend/src/styles.css`), so their pre-existing ad-hoc sizing —
// bare Tailwind classes are the *correct* choice there, not debt — can't be closed the way
// PENDING_SIZES was. This is a separate, file-granular allowlist so that real ratchet
// (PENDING_SIZES, which must stay empty) isn't diluted with debt that has nowhere to migrate to.
const PENDING_GATEKEEPER_SIZES = new Set([
  'packages/gatekeeper-context/app/ContextLibraryPage.tsx',
  'packages/gatekeeper-context/app/ErrorBoundary.tsx',
  'packages/gatekeeper-scheduler/app/ErrorBoundary.tsx',
  'packages/gatekeeper-scheduler/app/SchedulerPage.tsx',
])

test('sizing comes from the text-ui-* scale outside the pending allowlist', () => {
  const offenders = []
  for (const file of allScanFiles()) {
    const rel = repoPath(file)
    if (PENDING_SIZES.has(rel) || PENDING_GATEKEEPER_SIZES.has(rel)) continue
    const text = readFileSync(file, 'utf8')
    const hits = []
    if (BANNED_SIZE.test(text)) hits.push('ad-hoc or Tailwind size')
    if (BANNED_TRACKING.test(text)) hits.push('px letter-spacing')
    if (hits.length) offenders.push(`${rel}: ${hits.join(', ')}`)
  }
  assert.deepEqual(offenders, [], 'migrate to text-ui-*, or add to PENDING_SIZES/PENDING_GATEKEEPER_SIZES')
})

test('the sizes allowlist has no stale entries', () => {
  const stale = [...PENDING_SIZES].filter((rel) => {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    return !BANNED_SIZE.test(text) && !BANNED_TRACKING.test(text)
  })
  assert.deepEqual(stale, [], 'these are clean — remove them from PENDING_SIZES')
})

// The sizing ratchet closed at zero. This asserts it stays there: re-growing PENDING_SIZES now
// requires deleting this test rather than quietly appending a path to the Set above.
test('PENDING_SIZES stays empty', () => {
  assert.deepEqual([...PENDING_SIZES], [])
})

test('the gatekeeper sizes allowlist has no stale entries', () => {
  const stale = [...PENDING_GATEKEEPER_SIZES].filter((rel) => {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    return !BANNED_SIZE.test(text) && !BANNED_TRACKING.test(text)
  })
  assert.deepEqual(stale, [], 'these are clean — remove them from PENDING_GATEKEEPER_SIZES')
})
