# Contentstack (Venus) Design System Re-skin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin all three UI surfaces to Contentstack's Venus design system by re-targeting the existing CSS token layer — colour, corner radius, and elevation — without rewriting any component.

**Architecture:** The frontend styles the Kumo component library through Tailwind v4 `@theme` variables plus Kumo semantic-token overrides. Those token blocks are currently duplicated across three packages and have already drifted. We extract them into one `@gadgets/design-tokens` package, then re-target that single file to Venus values. A repo-wide ratchet test enforces that no legacy Cloudflare palette colour survives.

**Tech Stack:** Tailwind v4 (`@tailwindcss/vite`), `@cloudflare/kumo`, React 19, Vite 7, Vitest 4, `node:test` for repo-level script tests, pnpm workspaces.

## Global Constraints

- **pnpm only.** Never `npm`. Every command in this plan uses pnpm.
- **Do not install `@contentstack/venus-components`.** It is 14.1 MB / 1457 files with ~60 runtime deps. Its `build/variables.css` is the *specification*; the dependency is deliberately not added.
- **Brand primary is `#6c5ce7`** (Venus `brand-primary-base`), hover `#5d50be`. The supplied logo is `#7c4dff` and intentionally differs — do not "fix" this.
- **Do not change the type scale.** `--text-xs/sm/base/lg` and their line heights stay exactly as they are.
- **Do not change `--spacing`.** The 4px Tailwind base stays. Venus's 2px scale is not adopted.
- **Do not change font families.** `--font-sans` and `--font-mono` stay as-is; fonts are deferred to a separate discussion.
- **Do not touch third-party vendor brand colours.** Slack `#4A154B`, Google `#4285F4`/`#34A853`, Discord `#5865F2`, Jira `#0052CC`/`#2684FF`, GitHub `#24292e`, Linear `#5e6ad2`, Spotify `#1DB954`, `#EE3524`, `#03a9f4`. These live in `vendorColors.ts` and in gatekeeper HTML; re-tinting them is a defect.
- **Kumo `danger` = Venus warning red; Kumo `warning` = Venus attention amber.** The names do not line up; follow this mapping everywhere.
- **Verification per task:** `pnpm lint` (oxlint + recursive `tsc --noEmit`) must pass before every commit.
- Full design rationale: `docs/superpowers/specs/2026-08-06-contentstack-design-system-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/legacy-palette.test.js` (new) | Repo-wide ratchet: fails if a legacy Cloudflare hex appears outside the shrinking allowlist. |
| `packages/design-tokens/package.json` (new) | Workspace package `@gadgets/design-tokens`, CSS-only, `exports` map. |
| `packages/design-tokens/tokens.css` (new) | Single source of truth: `@theme` light block, `[data-mode="dark"]` block, `.themed-*` elevation utilities. |
| `packages/workshop-frontend/src/styles.css` | Imports shared tokens; keeps app-specific rules (animations, scrollbars, z-index fixes). |
| `packages/workshop-frontend/src/theme.ts` | Runtime accent seeding; default seed + dark-fill clamp. |
| `packages/workshop-frontend/src/components/monacoTheme.ts` | Monaco syntax + chrome colours, both modes. |
| `packages/workshop-frontend/src/CodeDiffEditor.css` | Diff viewer palette (`--gd-*`), both modes. |
| `packages/workshop-frontend/src/components/MeshBackground.tsx` | Decorative mesh line colour. |
| `packages/workshop-frontend/src/AdminPage.tsx` | Accent-picker presets. |
| `packages/gatekeeper-context/app/styles.css`, `app/index.html`, `app/ContextLibraryPage.tsx` | Context Library UI. |
| `packages/gatekeeper-scheduler/app/styles.css`, `app/index.html` | Scheduler UI. |
| `packages/mcp-shared/src/html.ts` | Server-rendered OAuth/connect page shell. |
| `packages/workshop-shared/src/api.ts` | `DEFAULT_SITE_NAME`. |
| `packages/workshop-frontend/index.html`, `public/favicon.svg` | Product identity. |

**Note on `packages/design-tokens/`:** it is CSS-only and has no `build`, `test`, or `types:check` script, so the recursive root scripts skip it via `--if-present`. Its tests live in `workshop-frontend` (which already has Vitest configured) and read the CSS off disk.

---

## Task 1: Legacy-palette ratchet test

Establishes the automated gate every later task uses. The allowlist starts with all ten currently-offending files and shrinks task by task; a second test fails if an allowlist entry is stale, so nobody can convert a file and forget to tighten the ratchet.

**Files:**
- Create: `scripts/legacy-palette.test.js`

**Interfaces:**
- Produces: `scripts/legacy-palette.test.js` with an exported-by-convention `PENDING` constant (a `Set` of repo-relative paths). Later tasks delete entries from it. No runtime import surface — it is a test file run by `node --test`.

- [ ] **Step 1: Write the test**

Create `scripts/legacy-palette.test.js`:

```js
// Ratchet guard for the Contentstack design-system migration.
//
// LEGACY holds hex values from the Cloudflare-era palette (brand orange, the warm neutral
// surface ramp, and the warm Monaco/diff colours). Any source file still containing one must
// be listed in PENDING. As each file is converted it is removed from PENDING, and the second
// test below fails if a PENDING entry no longer needs to be there — so the list can only shrink.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
  'packages/gatekeeper-context/app/styles.css',
  'packages/gatekeeper-scheduler/app/index.html',
  'packages/gatekeeper-scheduler/app/styles.css',
  'packages/mcp-shared/src/html.ts',
  'packages/workshop-frontend/src/CodeDiffEditor.css',
  'packages/workshop-frontend/src/components/monacoTheme.ts',
  'packages/workshop-frontend/src/styles.css',
  'packages/workshop-frontend/src/theme.ts',
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
    const hits = legacyHits(readFileSync(join(ROOT, rel), 'utf8').toLowerCase())
    if (!hits.length) stale.push(rel)
  }
  assert.deepEqual(stale, [], 'these files are clean — remove them from PENDING')
})
```

- [ ] **Step 2: Run the test to verify it passes against the current baseline**

Run: `node --test scripts/legacy-palette.test.js`
Expected: PASS, 2 tests. (It passes now because PENDING exactly matches today's offenders. Its job is to *fail* the moment a new legacy colour is added, or an entry goes stale.)

- [ ] **Step 3: Verify the ratchet actually bites**

Temporarily delete `'packages/workshop-frontend/src/theme.ts'` from `PENDING`, then run:

Run: `node --test scripts/legacy-palette.test.js`
Expected: FAIL on the first test, reporting `packages/workshop-frontend/src/theme.ts: #ff4801`.

Restore the entry and re-run. Expected: PASS. This step is a proof the guard works — do not skip it.

- [ ] **Step 4: Commit**

```bash
git add scripts/legacy-palette.test.js
git commit -m "test: add legacy-palette ratchet for the Contentstack re-skin"
```

---

## Task 2: Extract `@gadgets/design-tokens`

Pure refactor — no visual change to `workshop-frontend`. The two gatekeeper apps converge onto the frontend's superset of tokens, which is a small deliberate change (they previously fell back to Kumo defaults for tokens they never overrode).

**Files:**
- Create: `packages/design-tokens/package.json`, `packages/design-tokens/tokens.css`
- Modify: `packages/workshop-frontend/src/styles.css`, `packages/workshop-frontend/package.json`
- Modify: `packages/gatekeeper-context/app/styles.css`, `packages/gatekeeper-context/package.json`
- Modify: `packages/gatekeeper-scheduler/app/styles.css`, `packages/gatekeeper-scheduler/package.json`
- Test: `packages/workshop-frontend/src/designTokens.test.ts`

**Interfaces:**
- Produces: package `@gadgets/design-tokens`, importable from CSS as `@import "@gadgets/design-tokens/tokens.css";`. The file defines one `@theme { … }` block and one `[data-mode="dark"] { … }` block, plus the `.themed-*` utility classes.
- Produces: `packages/workshop-frontend/src/designTokens.test.ts` exporting nothing; later tasks add cases to it.

- [ ] **Step 1: Write the failing test**

Create `packages/workshop-frontend/src/designTokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL('../../design-tokens/tokens.css', import.meta.url)),
  'utf8',
)

/** Extracts the body of the `@theme { … }` block (light mode). */
export function lightBlock(css: string): string {
  const start = css.indexOf('@theme {')
  if (start === -1) throw new Error('no @theme block')
  return css.slice(start, css.indexOf('\n}', start))
}

/** Extracts the body of the `[data-mode="dark"] { … }` block. */
export function darkBlock(css: string): string {
  const start = css.indexOf('[data-mode="dark"] {')
  if (start === -1) throw new Error('no dark block')
  return css.slice(start, css.indexOf('\n}', start))
}

/** Reads a custom property's value out of a block body. */
export function token(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
  if (!match) throw new Error(`token ${name} not found`)
  return match[1].trim()
}

// Every Kumo semantic token the app relies on. A token silently dropped during the extraction
// would fall back to Kumo's own default and quietly de-theme part of the UI.
const REQUIRED_TOKENS = [
  '--color-kumo-base', '--color-kumo-elevated', '--color-kumo-tint',
  '--color-kumo-overlay', '--color-kumo-recessed', '--color-kumo-control',
  '--color-kumo-contrast', '--color-kumo-fill', '--color-kumo-fill-hover',
  '--color-kumo-interact', '--color-kumo-brand', '--color-kumo-brand-hover',
  '--color-kumo-line', '--color-kumo-ring', '--color-kumo-bubble-user',
  '--color-kumo-info', '--color-kumo-info-tint',
  '--color-kumo-warning', '--color-kumo-warning-tint',
  '--color-kumo-danger', '--color-kumo-danger-tint',
  '--color-kumo-success', '--color-kumo-success-tint',
  '--text-color-kumo-default', '--text-color-kumo-default-hover',
  '--text-color-kumo-inverse', '--text-color-kumo-strong',
  '--text-color-kumo-subtle', '--text-color-kumo-inactive',
  '--text-color-kumo-brand', '--text-color-kumo-link',
  '--text-color-kumo-success', '--text-color-kumo-danger', '--text-color-kumo-warning',
]

describe('shared design tokens', () => {
  it('defines every required token in light mode', () => {
    const block = lightBlock(TOKENS_CSS)
    const missing = REQUIRED_TOKENS.filter((t) => !block.includes(`${t}:`))
    expect(missing).toEqual([])
  })

  it('defines every required token in dark mode', () => {
    const block = darkBlock(TOKENS_CSS)
    const missing = REQUIRED_TOKENS.filter((t) => !block.includes(`${t}:`))
    expect(missing).toEqual([])
  })

  it('does not redefine the type scale or spacing base', () => {
    // These are deliberately out of scope; a stray definition here would reflow the whole app.
    for (const forbidden of ['--text-xs:', '--text-sm:', '--text-base:', '--text-lg:', '--spacing:']) {
      expect(TOKENS_CSS).not.toContain(forbidden)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/workshop-frontend && pnpm vitest run src/designTokens.test.ts`
Expected: FAIL — `ENOENT` on `../../design-tokens/tokens.css`, because the package does not exist yet.

- [ ] **Step 3: Create the package manifest**

Create `packages/design-tokens/package.json`:

```json
{
  "name": "@gadgets/design-tokens",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./tokens.css": "./tokens.css"
  },
  "files": ["tokens.css"]
}
```

- [ ] **Step 4: Create `tokens.css` by moving the existing blocks verbatim**

Create `packages/design-tokens/tokens.css`. Move, **without changing any value**:

1. The whole `@theme { … }` block from `packages/workshop-frontend/src/styles.css`, **except** the `FONTS` and `TEXT SIZES` groups — those stay in the frontend's own `styles.css` (see the test in Step 1, which forbids them here).
2. The whole `[data-mode="dark"] { … }` block from the same file.
3. All twelve `.themed-*` rules and their eleven `[data-mode="dark"] .themed-*` overrides.

Start the file with a header comment:

```css
/* Shared design tokens for every Gadgets UI surface.
   Imported by workshop-frontend, gatekeeper-context and gatekeeper-scheduler so the three
   cannot drift apart again. Values follow Contentstack's Venus design system; see
   docs/superpowers/specs/2026-08-06-contentstack-design-system-design.md.

   Deliberately NOT defined here: font families, the type scale, and Tailwind's --spacing base.
   Those remain per-surface and out of scope for the Venus migration. */
```

- [ ] **Step 5: Wire up `workshop-frontend`**

In `packages/workshop-frontend/package.json`, add to `dependencies` (keep alphabetical order — it goes directly after `@gadgets/error-reporting`):

```json
    "@gadgets/design-tokens": "workspace:*",
```

In `packages/workshop-frontend/src/styles.css`, replace the removed blocks. The first five lines become:

```css
@source "../node_modules/@cloudflare/kumo/dist/**/*.{js,jsx,ts,tsx}";
@import "@cloudflare/kumo/styles";
@import "tailwindcss";
@import "@gadgets/design-tokens/tokens.css";
@custom-variant dark (&:where([data-mode="dark"], [data-mode="dark"] *));
```

Keep a `@theme { … }` block in `styles.css` containing only the `FONTS` and `TEXT SIZES` groups.

- [ ] **Step 6: Wire up both gatekeeper apps**

Add the same `"@gadgets/design-tokens": "workspace:*"` dependency to `packages/gatekeeper-context/package.json` and `packages/gatekeeper-scheduler/package.json`.

In `packages/gatekeeper-context/app/styles.css` and `packages/gatekeeper-scheduler/app/styles.css`: delete their `@theme` colour groups and their entire `[data-mode="dark"]` blocks, add `@import "@gadgets/design-tokens/tokens.css";` after the `@import "tailwindcss";` line, and keep only their own `--font-sans` / `--font-mono` and layout rules (`html, body, #root`, `body`, `.press`, the `cursor: pointer` reset, and — in gatekeeper-context — anything else app-specific).

- [ ] **Step 7: Install and verify the import resolves**

Run: `pnpm install`
Run: `pnpm --filter @gadgets/workshop-frontend build && pnpm --filter @gadgets/gatekeeper-context build && pnpm --filter @gadgets/gatekeeper-scheduler build`
Expected: all three build.

**If Tailwind cannot resolve the package specifier**, fall back to a relative import in all three files and continue — this is an accepted fallback, not a blocker:

```css
@import "../../design-tokens/tokens.css";
```

(from `workshop-frontend/src/` and from each gatekeeper's `app/`, the path is `../../design-tokens/tokens.css`.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd packages/workshop-frontend && pnpm vitest run src/designTokens.test.ts`
Expected: PASS, 3 tests.

Run: `node --test scripts/legacy-palette.test.js`
Expected: FAIL on the stale-entry test — `packages/gatekeeper-context/app/styles.css` and `packages/gatekeeper-scheduler/app/styles.css` are now clean.

- [ ] **Step 9: Tighten the ratchet**

In `scripts/legacy-palette.test.js`, remove these two entries from `PENDING`:

```
'packages/gatekeeper-context/app/styles.css',
'packages/gatekeeper-scheduler/app/styles.css',
```

Add `'packages/design-tokens/tokens.css'` to `PENDING` — it now holds the legacy values that moved out of `styles.css`.

Run: `node --test scripts/legacy-palette.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 10: Lint and commit**

Run: `pnpm lint`
Expected: PASS.

```bash
git add packages/design-tokens packages/workshop-frontend packages/gatekeeper-context packages/gatekeeper-scheduler scripts/legacy-palette.test.js pnpm-lock.yaml
git commit -m "refactor: extract shared design tokens into @gadgets/design-tokens"
```

---

## Task 3: Light palette → Venus

**Files:**
- Modify: `packages/design-tokens/tokens.css` (the `@theme` block)
- Test: `packages/workshop-frontend/src/designTokens.test.ts`

**Interfaces:**
- Consumes: `lightBlock()`, `token()` from Task 2's test file.
- Produces: final light token values, consumed visually by every surface.

- [ ] **Step 1: Write the failing tests**

Append to `packages/workshop-frontend/src/designTokens.test.ts`:

```ts
/** Converts `#rgb`, `#rrggbb` or `#rrggbbaa` to linear-light sRGB (alpha ignored). */
function hexToLinear(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  return channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two hex colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(hexToLinear(a)), relativeLuminance(hexToLinear(b))]
    .sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('Venus light palette', () => {
  const light = lightBlock(TOKENS_CSS)

  it('uses the Venus brand purple', () => {
    expect(token(light, '--color-kumo-brand')).toBe('#6c5ce7')
    expect(token(light, '--color-kumo-brand-hover')).toBe('#5d50be')
  })

  it('uses Venus cool-grey surfaces', () => {
    expect(token(light, '--color-kumo-base')).toBe('#ffffff')
    expect(token(light, '--color-kumo-elevated')).toBe('#f7f9fc')
    expect(token(light, '--color-kumo-tint')).toBe('#edf1f7')
    expect(token(light, '--color-kumo-recessed')).toBe('#dde3ee')
  })

  it('keeps the line token translucent so borders survive on every surface', () => {
    // A solid #dde3ee line is invisible on the recessed and fill-hover surfaces, which are
    // themselves #dde3ee. The token must carry alpha.
    const line = token(light, '--color-kumo-line')
    expect(line).toMatch(/^#[0-9a-f]{8}$/)
  })

  it('meets WCAG AA for body text on both light surfaces', () => {
    const base = token(light, '--color-kumo-base')
    const elevated = token(light, '--color-kumo-elevated')
    const body = token(light, '--text-color-kumo-default')
    expect(contrast(body, base)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(body, elevated)).toBeGreaterThanOrEqual(4.5)
  })

  it('meets WCAG AA for brand, link and status text on the base surface', () => {
    const base = token(light, '--color-kumo-base')
    for (const name of [
      '--text-color-kumo-brand', '--text-color-kumo-link', '--text-color-kumo-subtle',
      '--text-color-kumo-success', '--text-color-kumo-danger', '--text-color-kumo-warning',
    ]) {
      expect(contrast(token(light, name), base), name).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('meets WCAG AA for white label text on the primary button', () => {
    expect(contrast('#ffffff', token(light, '--color-kumo-brand'))).toBeGreaterThanOrEqual(4.5)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/workshop-frontend && pnpm vitest run src/designTokens.test.ts`
Expected: FAIL — the brand assertion reports `#ff4801`, and the line assertion fails on `#1411100f`… (actually `#1411100f` *is* 8-digit, so that one passes; the brand and surface assertions are the failing ones).

- [ ] **Step 3: Replace the light colour tokens**

In `packages/design-tokens/tokens.css`, replace every colour group inside `@theme { … }` with:

```css
  /* ===== VENUS SURFACES ===== */
  --color-kumo-base: #ffffff;
  --color-kumo-elevated: #f7f9fc;
  --color-kumo-tint: #edf1f7;
  --color-kumo-overlay: #ffffff;
  --color-kumo-recessed: #dde3ee;
  --color-kumo-control: #ffffff;
  --color-kumo-contrast: #222222;
  --color-kumo-fill: #edf1f7;
  --color-kumo-fill-hover: #dde3ee;
  --color-kumo-interact: #c7d0e1;

  /* ===== BRAND (Orchid Purple P400) ===== */
  --color-kumo-brand: #6c5ce7;
  --color-kumo-brand-hover: #5d50be;

  /* ===== LINES =====
     Translucent on purpose: `recessed` and `fill-hover` are both #dde3ee, so a solid
     #dde3ee hairline would be invisible on them. Derived from Venus `font-base` at 12%. */
  --color-kumo-line: #4751611f;
  --color-kumo-ring: #c7d0e1;

  /* ===== CHAT ===== */
  --color-kumo-bubble-user: #f8f6ff;

  /* ===== STATUS =====
     Kumo `danger` maps to Venus *warning* (red); Kumo `warning` maps to Venus *attention*
     (amber). `info` uses the readable aqua B600 rather than Venus's cyan, so its pale
     companion is re-derived at that hue instead of using Venus `info-light`. */
  --color-kumo-info: #0469e3;
  --color-kumo-info-tint: #eef5fe;
  --color-kumo-warning: #ffae0a;
  --color-kumo-warning-tint: #fff8eb;
  --color-kumo-danger: #d62400;
  --color-kumo-danger-tint: #ffeeeb;
  --color-kumo-success: #007a52;
  --color-kumo-success-tint: #f5fffc;

  /* ===== TOOLTIP ===== */
  --color-kumo-tip-shadow: #47516114;
  --color-kumo-tip-stroke: transparent;

  /* ===== TEXT =====
     `warning` text uses Venus attention-*dark*: #ffae0a on white is 1.86:1 and fails AA. */
  --text-color-kumo-default: #475161;
  --text-color-kumo-default-hover: #212121;
  --text-color-kumo-inverse: #ffffff;
  --text-color-kumo-strong: #222222;
  --text-color-kumo-subtle: #647696;
  --text-color-kumo-inactive: #a9b6cb;
  --text-color-kumo-brand: #6c5ce7;
  --text-color-kumo-link: #6c5ce7;
  --text-color-kumo-success: #007a52;
  --text-color-kumo-danger: #d62400;
  --text-color-kumo-warning: #704b00;

  /* ===== CUSTOM BRAND TOKENS ===== */
  --color-accent-100: #6c5ce7;
  --color-accent-200: #9387ed;
  --color-background-100: #ffffff;
  --color-background-200: #f7f9fc;
  --color-background-300: #edf1f7;
  --color-foreground-100: #222222;
  --color-foreground-200: #212121;
  --color-foreground-300: #475161;
  --color-border-100: #dde3ee;
  --color-border-100-50: #dde3ee80;
  --color-selection-bg: #efedfc;
  --color-selection-text: #3e3871;
  --color-shadow-accent-light: #b6aef3;
  --color-shadow-accent-dark: #3e3871;

  /* ===== CATEGORY COLOURS =====
     `media` moves off purple: a purple category chip is ambiguous against a purple brand. */
  --color-compute-100: #0469e3;
  --color-compute-200: #0469e31a;
  --color-storage-100: #bd59fa;
  --color-storage-200: #bd59fa1a;
  --color-ai-100: #007a52;
  --color-ai-200: #f5fffc;
  --color-media-100: #43b7c2;
  --color-media-200: #43b7c21a;

  /* ===== STATUS COLOURS ===== */
  --color-status-live: #007a52;
  --color-status-draft: #ffae0a;
  --color-status-building: #0469e3;
```

Leave `--radius-*`, `--shadow-stack`, `--ease-*`, `--container-*`, `--spacing` and transition tokens untouched — Task 5 handles radius and elevation.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/workshop-frontend && pnpm vitest run src/designTokens.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Lint and commit**

Run: `pnpm lint`
Expected: PASS.

```bash
git add packages/design-tokens/tokens.css packages/workshop-frontend/src/designTokens.test.ts
git commit -m "feat: re-target the light palette to Venus"
```

---

## Task 4: Dark palette → Venus-derived

Venus ships no dark tokens. These values were derived from Venus hues and approved visually; the contrast figures were measured, not estimated.

**Files:**
- Modify: `packages/design-tokens/tokens.css` (the `[data-mode="dark"]` block)
- Test: `packages/workshop-frontend/src/designTokens.test.ts`

**Interfaces:**
- Consumes: `darkBlock()`, `token()`, `contrast()` from Tasks 2–3.

- [ ] **Step 1: Write the failing tests**

Append to `packages/workshop-frontend/src/designTokens.test.ts`:

```ts
/** Converts an `oklch(L C H)` string to linear-light sRGB, clipped to gamut. */
function oklchToLinear(value: string): [number, number, number] {
  const m = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (!m) throw new Error(`not an oklch colour: ${value}`)
  const [L, C, H] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]
}

const toSrgbChannel = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

/** Renders any oklch()/hex token value as a hex string so `contrast()` can consume it. */
function asHex(value: string): string {
  if (value.startsWith('#')) return value
  const rgb = oklchToLinear(value)
  return '#' + rgb.map((v) => Math.round(toSrgbChannel(v) * 255).toString(16).padStart(2, '0')).join('')
}

describe('Venus-derived dark palette', () => {
  const dark = darkBlock(TOKENS_CSS)

  it('keeps solid brand fills but lightens brand text (decision D5)', () => {
    expect(token(dark, '--color-kumo-brand')).toBe('#6c5ce7')
    expect(token(dark, '--text-color-kumo-brand')).toBe('#ada4f4')
    expect(token(dark, '--text-color-kumo-link')).toBe('#ada4f4')
  })

  it('uses the approved dark status colours (decision D6)', () => {
    expect(token(dark, '--color-kumo-success')).toBe('#48dba2')
    expect(token(dark, '--color-kumo-danger')).toBe('#ff735f')
    expect(token(dark, '--color-kumo-warning')).toBe('#ffbc36')
    expect(token(dark, '--color-kumo-info')).toBe('#74b4ff')
  })

  it('meets WCAG AA for text and status colours on all three dark surfaces', () => {
    const surfaces = ['--color-kumo-base', '--color-kumo-elevated', '--color-kumo-tint']
      .map((name) => asHex(token(dark, name)))
    const foregrounds = [
      '--text-color-kumo-default', '--text-color-kumo-subtle', '--text-color-kumo-brand',
      '--text-color-kumo-success', '--text-color-kumo-danger', '--text-color-kumo-warning',
    ]
    for (const name of foregrounds) {
      const fg = asHex(token(dark, name))
      for (const bg of surfaces) {
        expect(contrast(fg, bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('meets WCAG AA for white label text on the dark primary button', () => {
    expect(contrast('#ffffff', asHex(token(dark, '--color-kumo-brand')))).toBeGreaterThanOrEqual(4.5)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/workshop-frontend && pnpm vitest run src/designTokens.test.ts`
Expected: FAIL — brand reports `#b84e00`, status colours report the old oklch values.

- [ ] **Step 3: Replace the dark tokens**

In `packages/design-tokens/tokens.css`, replace the contents of `[data-mode="dark"] { … }` with:

```css
  /* Surfaces: violet-tinted at hue 285, which sits within a few degrees of Venus P400 (~288). */
  --color-kumo-base: oklch(0.15 0.015 285);
  --color-kumo-elevated: oklch(0.19 0.016 285);
  --color-kumo-tint: oklch(0.25 0.024 285);
  --color-kumo-overlay: oklch(0.19 0.016 285);
  --color-kumo-recessed: oklch(0.12 0.014 285);
  --color-kumo-control: oklch(0.19 0.016 285);
  --color-kumo-contrast: var(--color-kumo-brand);
  --color-kumo-strong: var(--color-kumo-brand-hover);
  --color-kumo-fill: oklch(0.25 0.024 285);
  --color-kumo-fill-hover: oklch(0.31 0.036 285);
  --color-kumo-interact: oklch(0.38 0.04 285);
  --color-kumo-line: oklch(0.32 0.022 285);
  --color-kumo-ring: oklch(0.52 0.08 288);
  --color-kumo-bubble-user: oklch(0.25 0.024 285);

  /* Fills keep true Venus purple; brand *text* lightens further down (decision D5). */
  --color-kumo-brand: #6c5ce7;
  --color-kumo-brand-hover: #5d50be;

  /* Each status keeps its Venus hue, lifted in lightness until legible on a dark surface. */
  --color-kumo-info: #74b4ff;
  --color-kumo-info-tint: oklch(0.27 0.065 255);
  --color-kumo-warning: #ffbc36;
  --color-kumo-warning-tint: oklch(0.28 0.06 78);
  --color-kumo-danger: #ff735f;
  --color-kumo-danger-tint: oklch(0.27 0.07 30);
  --color-kumo-success: #48dba2;
  --color-kumo-success-tint: oklch(0.27 0.055 163);

  --color-kumo-tip-shadow: #00000066;
  --color-kumo-tip-stroke: oklch(0.32 0.022 285);

  --text-color-kumo-default: oklch(0.92 0.008 285);
  --text-color-kumo-default-hover: oklch(0.96 0.006 285);
  --text-color-kumo-inverse: #ffffff;
  --text-color-kumo-strong: oklch(0.96 0.006 285);
  --text-color-kumo-subtle: oklch(0.70 0.02 285);
  --text-color-kumo-inactive: oklch(0.58 0.02 285);
  --text-color-kumo-brand: #ada4f4;
  --text-color-kumo-link: #ada4f4;
  --text-color-kumo-success: #48dba2;
  --text-color-kumo-danger: #ff735f;
  --text-color-kumo-warning: #ffbc36;

  --color-accent-100: #6c5ce7;
  --color-accent-200: #ada4f4;
  --color-background-100: oklch(0.15 0.015 285);
  --color-background-200: oklch(0.19 0.016 285);
  --color-background-300: oklch(0.25 0.024 285);
  --color-foreground-100: oklch(0.92 0.008 285);
  --color-foreground-200: oklch(0.78 0.015 285);
  --color-foreground-300: oklch(0.70 0.02 285);
  --color-border-100: oklch(0.32 0.022 285);
  --color-border-100-50: oklch(0.32 0.022 285 / 0.5);
  --color-selection-bg: color-mix(in srgb, var(--color-kumo-brand) 28%, transparent);
  --color-selection-text: oklch(0.97 0.006 285);
  --color-shadow-accent-light: #ada4f455;
  --color-shadow-accent-dark: #00000080;

  --color-compute-100: #74b4ff;
  --color-compute-200: oklch(0.27 0.065 255);
  --color-storage-100: #d79bfc;
  --color-storage-200: oklch(0.27 0.07 320);
  --color-ai-100: #48dba2;
  --color-ai-200: oklch(0.27 0.055 163);
  --color-media-100: #6fd3dd;
  --color-media-200: oklch(0.27 0.055 200);

  --color-status-live: #48dba2;
  --color-status-draft: #ffbc36;
  --color-status-building: #74b4ff;
```

Leave `--shadow-stack` in this block for Task 5.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/workshop-frontend && pnpm vitest run src/designTokens.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Lint and commit**

Run: `pnpm lint`
Expected: PASS.

```bash
git add packages/design-tokens/tokens.css packages/workshop-frontend/src/designTokens.test.ts
git commit -m "feat: derive the dark palette from Venus hues"
```

---

## Task 5: Radius ramp and Venus elevation

Radius adopts Venus's full `2/4/6/8/10` ramp. This is safe: radius changes no geometry, `rounded-sm` is unused, and pills use `rounded-full`, which Tailwind fixes at `9999px` independently of these tokens.

Elevation introduces five ramp variables that are themselves mode-aware, which lets nine of the eleven `[data-mode="dark"] .themed-*` overrides be deleted outright.

**Files:**
- Modify: `packages/design-tokens/tokens.css`
- Test: `packages/workshop-frontend/src/designTokens.test.ts`

**Interfaces:**
- Produces: `--shadow-venus-1|4|8|16|24`, defined in both the light and dark blocks. The `.themed-*` utilities reference them and therefore need no per-mode duplication.

- [ ] **Step 1: Write the failing tests**

Append to `packages/workshop-frontend/src/designTokens.test.ts`:

```ts
describe('Venus radius and elevation', () => {
  const light = lightBlock(TOKENS_CSS)
  const dark = darkBlock(TOKENS_CSS)

  it('uses the Venus radius ramp 2/4/6/8/10px', () => {
    expect(token(light, '--radius-sm')).toBe('0.125rem')
    expect(token(light, '--radius-md')).toBe('0.25rem')
    expect(token(light, '--radius-lg')).toBe('0.375rem')
    expect(token(light, '--radius-xl')).toBe('0.5rem')
    expect(token(light, '--radius-2xl')).toBe('0.625rem')
  })

  it('defines the elevation ramp in both modes', () => {
    for (const step of ['1', '4', '8', '16', '24']) {
      expect(light).toContain(`--shadow-venus-${step}:`)
      expect(dark).toContain(`--shadow-venus-${step}:`)
    }
  })

  it('tints light elevation with Venus purple and dark elevation with black', () => {
    expect(token(light, '--shadow-venus-4')).toContain('108, 92, 231')
    expect(token(dark, '--shadow-venus-4')).not.toContain('108, 92, 231')
  })

  it('drives every themed shadow utility from the ramp, not hardcoded warm browns', () => {
    // rgba(82, 16, 0, …) and rgba(20, 17, 16, …) were the Cloudflare-era shadow tints.
    expect(TOKENS_CSS).not.toContain('rgba(82, 16, 0')
    expect(TOKENS_CSS).not.toContain('rgba(20, 17, 16')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/workshop-frontend && pnpm vitest run src/designTokens.test.ts`
Expected: FAIL — `--radius-sm` is `0.25rem`, `--shadow-venus-*` are undefined, and the warm rgba tints are still present.

- [ ] **Step 3: Replace the radius tokens**

In the `@theme` block of `tokens.css`, replace the radius group:

```css
  /* Radius — Venus ramp (2/4/6/8/10px). */
  --radius-sm: 0.125rem;
  --radius-md: 0.25rem;
  --radius-lg: 0.375rem;
  --radius-xl: 0.5rem;
  --radius-2xl: 0.625rem;
```

- [ ] **Step 4: Add the elevation ramp to the light block**

Replace the `--shadow-stack` definition in `@theme` with:

```css
  /* Elevation — Venus ambience ramp: two neutral shadows under one brand-tinted glow. */
  --shadow-venus-1: 0 0 2px rgba(0, 0, 0, 0.14), 0 2px 2px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(108, 92, 231, 0.2);
  --shadow-venus-4: 0 2px 4px rgba(0, 0, 0, 0.14), 0 5px 5px rgba(0, 0, 0, 0.12), 0 1px 10px rgba(108, 92, 231, 0.2);
  --shadow-venus-8: 0 8px 10px 1px rgba(0, 0, 0, 0.14), 0 3px 14px 3px rgba(0, 0, 0, 0.12), 0 4px 15px rgba(108, 92, 231, 0.2);
  --shadow-venus-16: 0 16px 24px 2px rgba(0, 0, 0, 0.14), 0 6px 30px 5px rgba(0, 0, 0, 0.12), 0 8px 10px 3px rgba(108, 92, 231, 0.2);
  --shadow-venus-24: 0 24px 38px 3px rgba(0, 0, 0, 0.14), 0 9px 46px 8px rgba(0, 0, 0, 0.12), 0 11px 15px 8px rgba(108, 92, 231, 0.2);
  --shadow-stack: var(--shadow-venus-8);
```

- [ ] **Step 5: Add the black-ambience ramp to the dark block**

Add to `[data-mode="dark"] { … }` (a purple glow on a dark violet surface reads as muddy, so dark uses Venus's black-ambience variants):

```css
  --shadow-venus-1: 0 0 2px rgba(0, 0, 0, 0.14), 0 2px 2px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.2);
  --shadow-venus-4: 0 2px 4px rgba(0, 0, 0, 0.14), 0 5px 5px rgba(0, 0, 0, 0.12), 0 1px 10px rgba(0, 0, 0, 0.2);
  --shadow-venus-8: 0 8px 10px 1px rgba(0, 0, 0, 0.14), 0 3px 14px 3px rgba(0, 0, 0, 0.12), 0 4px 15px rgba(0, 0, 0, 0.2);
  --shadow-venus-16: 0 16px 24px 2px rgba(0, 0, 0, 0.14), 0 6px 30px 5px rgba(0, 0, 0, 0.12), 0 8px 10px rgba(0, 0, 0, 0.2);
  --shadow-venus-24: 0 24px 38px 3px rgba(0, 0, 0, 0.14), 0 9px 46px 8px rgba(0, 0, 0, 0.12), 0 11px 15px rgba(0, 0, 0, 0.2);
  --shadow-stack: var(--shadow-venus-8);
```

- [ ] **Step 6: Rewrite the themed shadow utilities**

Replace these six rules with ramp references:

```css
.themed-prompt-card-shadow { box-shadow: var(--shadow-venus-8); }
.themed-prompt-card-shadow:focus-within { box-shadow: var(--shadow-venus-16); }
.themed-thumbnail-shadow { box-shadow: var(--shadow-venus-4); }
.themed-floating-shadow { box-shadow: var(--shadow-venus-4); }
.themed-floating-shadow-lg { box-shadow: var(--shadow-venus-16); }
.themed-bottom-shadow { box-shadow: var(--shadow-venus-1); }
.themed-compact-shadow { box-shadow: var(--shadow-venus-1); }
.themed-compact-shadow:focus-within { box-shadow: var(--shadow-venus-4); }
.themed-card-hover-shadow:hover { box-shadow: var(--shadow-venus-4); }
.themed-row-hover-shadow:hover { box-shadow: var(--shadow-venus-1); }
```

Replace the one hardcoded tint in the user-bubble rule, keeping its token-driven inset:

```css
.themed-user-bubble-shadow {
  box-shadow:
    0 1px 1px rgba(0, 0, 0, 0.03),
    inset 0 1px 0 color-mix(in srgb, var(--color-kumo-fill) 65%, transparent);
}
```

Leave `.themed-surface-inset`, `.themed-inset-outline` and `.themed-accent-glow` **unchanged** — they already read from `--color-kumo-fill`, `--color-kumo-line` and `--color-kumo-brand`, so they re-theme automatically.

- [ ] **Step 7: Delete the now-redundant dark shadow overrides**

Because `--shadow-venus-*` is itself mode-aware, delete these nine `[data-mode="dark"]` rules entirely:

```
[data-mode="dark"] .themed-prompt-card-shadow
[data-mode="dark"] .themed-prompt-card-shadow:focus-within
[data-mode="dark"] .themed-thumbnail-shadow
[data-mode="dark"] .themed-floating-shadow
[data-mode="dark"] .themed-floating-shadow-lg
[data-mode="dark"] .themed-bottom-shadow
[data-mode="dark"] .themed-compact-shadow
[data-mode="dark"] .themed-compact-shadow:focus-within
[data-mode="dark"] .themed-card-hover-shadow:hover
[data-mode="dark"] .themed-row-hover-shadow:hover
```

**Keep** `[data-mode="dark"] .themed-surface-inset`, `[data-mode="dark"] .themed-inset-outline` and `[data-mode="dark"] .themed-user-bubble-shadow`: those deliberately swap `--color-kumo-fill` for `--color-kumo-line` in dark, which the ramp does not express. In the user-bubble dark override, change its `rgba(0, 0, 0, 0.15)` first shadow — it is already neutral, so it needs no edit; only confirm no warm tint remains.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd packages/workshop-frontend && pnpm vitest run src/designTokens.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 9: Tighten the ratchet**

Run: `node --test scripts/legacy-palette.test.js`

If it reports `packages/design-tokens/tokens.css` as stale, remove that entry from `PENDING` and re-run. Expected: PASS.

- [ ] **Step 10: Lint and commit**

Run: `pnpm lint`
Expected: PASS.

```bash
git add packages/design-tokens/tokens.css packages/workshop-frontend/src/designTokens.test.ts scripts/legacy-palette.test.js
git commit -m "feat: adopt the Venus radius ramp and elevation scale"
```

---

## Task 6: Runtime accent seeding

The admin accent override must keep working. The existing `oklch(from ${seed} 0.45 c h)` derivation is a *guard*: it stops a pale admin-chosen seed from producing an unreadable dark-mode button. Widen it to a clamp rather than removing it, so Contentstack purple (L ≈ 0.55) passes through intact while the failure mode stays closed.

**Files:**
- Modify: `packages/workshop-frontend/src/theme.ts`
- Test: `packages/workshop-frontend/src/theme.test.ts` (create)

**Interfaces:**
- Consumes: `DEFAULT_ACCENT_COLOR`, `applyAccentColor` from `./theme`.
- Produces: `DEFAULT_ACCENT_COLOR === '#6c5ce7'`; `accentVars()` internals unchanged in shape.

- [ ] **Step 1: Write the failing test**

Create `packages/workshop-frontend/src/theme.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { applyAccentColor, DEFAULT_ACCENT_COLOR } from './theme'

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('runtime accent seeding', () => {
  it('defaults to the Venus brand purple', () => {
    expect(DEFAULT_ACCENT_COLOR).toBe('#6c5ce7')
  })

  it('keeps the seed itself as the dark brand fill when it is already dark enough', () => {
    applyAccentColor(DEFAULT_ACCENT_COLOR)
    const brand = document.documentElement.style.getPropertyValue('--color-kumo-brand')
    // light-dark(<light>, <dark>) — the dark arm must clamp, not pin, so a mid-lightness
    // seed such as #6c5ce7 (L ~ 0.55) survives unchanged.
    expect(brand).toContain('clamp(')
    expect(brand).not.toContain('0.45 c h')
  })

  it('still guards pale seeds so white button text stays legible in dark mode', () => {
    applyAccentColor('#ffd400')
    const brand = document.documentElement.style.getPropertyValue('--color-kumo-brand')
    expect(brand).toContain('clamp(0.38')
    expect(brand).toContain('0.60')
  })

  it('clears every accent variable when given an invalid colour', () => {
    applyAccentColor(DEFAULT_ACCENT_COLOR)
    applyAccentColor('not-a-colour')
    expect(document.documentElement.style.getPropertyValue('--color-kumo-brand')).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/workshop-frontend && pnpm vitest run src/theme.test.ts`
Expected: FAIL — `DEFAULT_ACCENT_COLOR` is `'#ff4801'`.

- [ ] **Step 3: Update the default seed**

In `packages/workshop-frontend/src/theme.ts`, change the last line:

```ts
// The base/default accent, shown in the admin picker when no custom color is set.
export const DEFAULT_ACCENT_COLOR = '#6c5ce7'
```

- [ ] **Step 4: Widen the dark-fill guard to a clamp**

In `accentVars()`, replace the two brand entries:

```ts
    // Clamp rather than pin the dark-mode lightness. Pinning to 0.45 darkened every seed,
    // including one already in the safe band; removing the guard entirely would let a pale
    // admin-chosen accent produce a button that white label text cannot be read on.
    '--color-kumo-brand': `light-dark(${seed}, oklch(from ${seed} clamp(0.38, l, 0.60) c h))`,
    // Slightly darker for hover/pressed states.
    '--color-kumo-brand-hover': `light-dark(oklch(from ${seed} calc(l - 0.06) c h), oklch(from ${seed} clamp(0.32, calc(l - 0.07), 0.54) c h))`,
```

Leave `--color-accent-100`, `--color-accent-200`, `--text-color-kumo-brand`, `--text-color-kumo-link`, `--color-selection-bg` and `--color-selection-text` exactly as they are — the `0.76` text derivation already produces the D5 split.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/workshop-frontend && pnpm vitest run src/theme.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Tighten the ratchet**

Run: `node --test scripts/legacy-palette.test.js`
Expected: FAIL on the stale-entry test — `theme.ts` is clean.

Remove `'packages/workshop-frontend/src/theme.ts'` from `PENDING`, then re-run. Expected: PASS.

- [ ] **Step 7: Lint and commit**

Run: `pnpm lint`
Expected: PASS.

```bash
git add packages/workshop-frontend/src/theme.ts packages/workshop-frontend/src/theme.test.ts scripts/legacy-palette.test.js
git commit -m "feat: seed the runtime accent from Venus purple and clamp the dark fill"
```

---

## Task 7: Code surfaces — Monaco and the diff viewer

**Files:**
- Modify: `packages/workshop-frontend/src/components/monacoTheme.ts`
- Modify: `packages/workshop-frontend/src/CodeDiffEditor.css`

**Interfaces:**
- Consumes: nothing from earlier tasks (Monaco renders into its own DOM and cannot read the CSS variables, which is why these values are duplicated as literals).
- Produces: no new exports. `GADGETS_CODE_THEME_LIGHT`, `GADGETS_CODE_THEME_DARK`, `getGadgetsCodeTheme`, `defineGadgetsCodeTheme` and `monoFont` keep their current signatures.

- [ ] **Step 1: Replace the light Monaco syntax rules**

In `defineGadgetsCodeTheme`, in the `GADGETS_CODE_THEME_LIGHT` `rules` array:

```ts
      { token: '', foreground: '222222' },
      { token: 'comment', foreground: '8593ab', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6c5ce7' },
      { token: 'storage', foreground: '6c5ce7' },
      { token: 'operator', foreground: '647696' },
      { token: 'string', foreground: '007a52' },
      { token: 'number', foreground: 'ba5800' },
      { token: 'type', foreground: 'ba5800' },
      { token: 'class', foreground: 'ba5800' },
      { token: 'interface', foreground: 'ba5800' },
      { token: 'function', foreground: '0469e3' },
      { token: 'variable', foreground: '222222' },
      { token: 'variable.predefined', foreground: '0469e3' },
      { token: 'constant', foreground: 'ba5800' },
      { token: 'delimiter', foreground: '647696' },
      { token: 'tag', foreground: 'd62400' },
      { token: 'attribute.name', foreground: 'ba5800' },
      { token: 'attribute.value', foreground: '007a52' },
```

- [ ] **Step 2: Replace the light Monaco chrome colours**

In the same theme's `colors` object:

```ts
      'editor.background': '#ffffff',
      'editor.foreground': '#222222',
      'editorLineNumber.foreground': '#a9b6cb',
      'editorLineNumber.activeForeground': '#647696',
      'editorCursor.foreground': '#222222',
      'editor.selectionBackground': '#dcd7fa',
      'editor.inactiveSelectionBackground': '#edf1f7',
      'editor.selectionHighlightBackground': '#e8e4fb',
      'editor.wordHighlightBackground': '#e8e4fb',
      'editor.wordHighlightStrongBackground': '#dcd7fa',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': '#ffffff',
      'editorIndentGuide.background1': '#edf1f7',
      'editorIndentGuide.activeBackground1': '#c7d0e1',
      'editorWhitespace.foreground': '#dde3ee',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#c7d0e133',
      'scrollbarSlider.hoverBackground': '#a9b6cb55',
      'scrollbarSlider.activeBackground': '#64769677',
```

- [ ] **Step 3: Replace the dark Monaco syntax rules**

In the `GADGETS_CODE_THEME_DARK` `rules` array:

```ts
      { token: '', foreground: 'e6e4f0' },
      { token: 'comment', foreground: '7c7a94', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ada4f4' },
      { token: 'storage', foreground: 'ada4f4' },
      { token: 'operator', foreground: '9a97b0' },
      { token: 'string', foreground: '48dba2' },
      { token: 'number', foreground: 'ffbc36' },
      { token: 'type', foreground: 'ffbc36' },
      { token: 'class', foreground: 'ffbc36' },
      { token: 'interface', foreground: 'ffbc36' },
      { token: 'function', foreground: '74b4ff' },
      { token: 'variable', foreground: 'e6e4f0' },
      { token: 'variable.predefined', foreground: '74b4ff' },
      { token: 'constant', foreground: 'ffbc36' },
      { token: 'delimiter', foreground: '9a97b0' },
      { token: 'tag', foreground: 'ff735f' },
      { token: 'attribute.name', foreground: 'ffbc36' },
      { token: 'attribute.value', foreground: '48dba2' },
```

- [ ] **Step 4: Replace the dark Monaco chrome colours**

The dark editor background must match `--color-kumo-elevated` at `oklch(0.19 0.016 285)`, which is `#13131b`:

```ts
      'editor.background': '#13131b',
      'editor.foreground': '#e6e4f0',
      'editorLineNumber.foreground': '#6d6880',
      'editorLineNumber.activeForeground': '#9a97b0',
      'editorCursor.foreground': '#e6e4f0',
      'editor.selectionBackground': '#3b3468',
      'editor.inactiveSelectionBackground': '#2a2740',
      'editor.selectionHighlightBackground': '#2a2740',
      'editor.wordHighlightBackground': '#2a2740',
      'editor.wordHighlightStrongBackground': '#3b3468',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': '#13131b',
      'editorIndentGuide.background1': '#20202d',
      'editorIndentGuide.activeBackground1': '#383353',
      'editorWhitespace.foreground': '#2a2740',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#4b465f66',
      'scrollbarSlider.hoverBackground': '#5d587399',
      'scrollbarSlider.activeBackground': '#746d8fcc',
```

- [ ] **Step 5: Replace the diff viewer palette**

In `packages/workshop-frontend/src/CodeDiffEditor.css`, replace the two variable blocks:

```css
:where(.gadgets-diff-surface) {
  --gd-bg: #ffffff;
  --gd-fg: #222222;
  --gd-fg-num: #a9b6cb;
  --gd-add-bg: #eafaf3;
  --gd-add-bar: #007a52;
  --gd-add-num: #00472f;
  --gd-mod-bar: #ffae0a;
  --gd-del-bg: #ffeeeb;
  --gd-del-bar: #d62400;
  --gd-del-num: #701300;
  --gd-margin-line: #edf1f7;
  --gd-blank-bg: #f7f9fc;
  --gd-omitted-bg: color-mix(in srgb, var(--gd-del-bg) 88%, white);
  --gd-omitted-hover-bg: color-mix(in srgb, var(--gd-del-bg) 78%, white);
}

[data-mode="dark"] .gadgets-diff-surface {
  --gd-bg: #13131b;
  --gd-fg: #e6e4f0;
  --gd-fg-num: #6d6880;
  --gd-add-bg: #0f2f22;
  --gd-add-bar: #48dba2;
  --gd-add-num: #48dba2;
  --gd-mod-bar: #ffbc36;
  --gd-del-bg: #3a1a17;
  --gd-del-bar: #ff735f;
  --gd-del-num: #ff735f;
  --gd-margin-line: #2a2740;
  --gd-blank-bg: #0f0f16;
  --gd-omitted-bg: color-mix(in srgb, var(--gd-del-bg) 86%, var(--gd-bg));
  --gd-omitted-hover-bg: color-mix(in srgb, var(--gd-del-bg) 72%, var(--gd-bg));
}
```

Leave the rest of the file — every other rule already reads these variables.

- [ ] **Step 6: Tighten the ratchet**

Run: `node --test scripts/legacy-palette.test.js`
Expected: FAIL on the stale-entry test for both `monacoTheme.ts` and `CodeDiffEditor.css`.

Remove both entries from `PENDING`:

```
'packages/workshop-frontend/src/CodeDiffEditor.css',
'packages/workshop-frontend/src/components/monacoTheme.ts',
```

Run: `node --test scripts/legacy-palette.test.js`
Expected: PASS.

- [ ] **Step 7: Run the frontend suite**

Run: `cd packages/workshop-frontend && pnpm test`
Expected: PASS — no existing test asserts on these colours, so this is a regression check.

- [ ] **Step 8: Lint and commit**

Run: `pnpm lint`
Expected: PASS.

```bash
git add packages/workshop-frontend/src/components/monacoTheme.ts packages/workshop-frontend/src/CodeDiffEditor.css scripts/legacy-palette.test.js
git commit -m "feat: re-theme the code editor and diff viewer for Venus"
```

---

## Task 8: Remaining frontend colour

The ratchet does not cover these — `MeshBackground` stores RGB integers, and the admin presets are generic Tailwind colours rather than legacy Cloudflare ones. Verify them by inspection.

**Files:**
- Modify: `packages/workshop-frontend/src/components/MeshBackground.tsx`
- Modify: `packages/workshop-frontend/src/AdminPage.tsx`
- Audit: `packages/workshop-frontend/src/components/vendorColors.ts` and any file matching the grep in Step 3

- [ ] **Step 1: Cool the mesh background line colour**

In `packages/workshop-frontend/src/components/MeshBackground.tsx`, replace lines 6–9. The new values are Venus `font-secondary` `#647696`:

```ts
// Line color — Venus cool grey (font-secondary #647696).
const LINE_R = 100
const LINE_G = 118
const LINE_B = 150
```

- [ ] **Step 2: Fix the admin accent presets**

In `packages/workshop-frontend/src/AdminPage.tsx`, replace `ACCENT_PRESETS`. `#7c3aed` is removed because a near-miss purple sitting beside the real brand reads as a mistake:

```ts
// Preset accent colors offered in the Theme section ('' = default brand).
const ACCENT_PRESETS: { label: string; value: string }[] = [
  { label: 'Default', value: '' },
  { label: 'Contentstack', value: '#6c5ce7' },
  { label: 'Blue', value: '#0469e3' },
  { label: 'Green', value: '#007a52' },
  { label: 'Pink', value: '#db2777' },
  { label: 'Teal', value: '#0d9488' },
]
```

- [ ] **Step 3: Audit the remaining hardcoded hexes**

Run:

```bash
grep -rnoE "#[0-9a-fA-F]{6}\b" packages/workshop-frontend/src --include="*.tsx" --include="*.ts" | grep -v node_modules
```

For each hit, apply this rule:

- **Keep** third-party vendor marks: `#4A154B`, `#E01E5A`, `#ECB22E`, `#2684FF`, `#0052CC`, `#5865F2`, `#4285F4`, `#34A853`, `#24292e`, `#7C3085`, `#7983F5`, `#5e6ad2`, `#1DB954`, `#EE3524`, `#03a9f4`. These identify other companies.
- **Retarget** app colours to the nearest Venus token: `#7c3aed` → `#6c5ce7`, `#f6edff` → `#efedfc`, `#f4801f` → `#ffae0a`, `#f9ab41` → `#ffae0a`.

- [ ] **Step 4: Verify no legacy colour was reintroduced**

Run: `node --test scripts/legacy-palette.test.js`
Expected: PASS.

Run: `cd packages/workshop-frontend && pnpm test`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `pnpm lint`
Expected: PASS.

```bash
git add packages/workshop-frontend/src
git commit -m "feat: re-theme the mesh background, accent presets and stray app colours"
```

---

## Task 9: Server-rendered HTML

`mcp-shared/src/html.ts` is the highest priority here — it carries the literal old brand on OAuth pages users see during connect flows.

**Files:**
- Modify: `packages/mcp-shared/src/html.ts`
- Modify: `packages/gatekeeper-context/app/index.html`, `packages/gatekeeper-context/app/ContextLibraryPage.tsx`
- Modify: `packages/gatekeeper-scheduler/app/index.html`

- [ ] **Step 1: Re-theme the MCP connect-page shell**

In `packages/mcp-shared/src/html.ts`, replace the light `:root` colour block:

```css
    --base: #ffffff;
    --control: #ffffff;
    --line: #dde3ee;
    --text: #475161;
    --strong: #222222;
    --subtle: #647696;
    --brand: #6c5ce7;
    --danger: #d62400;
    /* Kumo's primary button is "contrast": near-black in light mode, the accent in dark. */
    --contrast: #222222;
    --on-contrast: #ffffff;
```

and the dark override:

```css
      --base: oklch(0.15 0.015 285);
      --control: oklch(0.19 0.016 285);
      --line: oklch(0.32 0.022 285);
      --text: oklch(0.92 0.008 285);
      --strong: oklch(0.96 0.006 285);
      --subtle: oklch(0.70 0.02 285);
      --brand: #ada4f4;
      --danger: #ff735f;
      --contrast: #6c5ce7;
```

Note this page uses `prefers-color-scheme`, not `data-mode` — it is rendered by a Worker with no access to the app's theme state. That is correct and stays.

- [ ] **Step 2: Fix the two anti-FOUC background colours**

In `packages/gatekeeper-context/app/index.html`, change the inline background from `#fffdfb` to `#ffffff`.
In `packages/gatekeeper-scheduler/app/index.html`, change the inline background from `#fcfcfb` to `#ffffff`.

- [ ] **Step 3: Re-theme the Context Library code colours**

`packages/gatekeeper-context/app/ContextLibraryPage.tsx` carries its own copy of the warm code palette. Apply the same substitutions as Task 7 Step 1:

- `#1f1d1a` → `#222222`
- `#a39990` → `#8593ab`
- `#b56a1f` → `#ba5800`
- `#6b6157` → `#647696`

- [ ] **Step 4: Tighten the ratchet — this should now empty it**

Run: `node --test scripts/legacy-palette.test.js`
Expected: FAIL on the stale-entry test for all four remaining files.

Remove the last four entries so `PENDING` becomes an empty `Set`:

```js
// Files not yet migrated. Remove an entry in the task that converts it.
const PENDING = new Set([])
```

Run: `node --test scripts/legacy-palette.test.js`
Expected: PASS, 2 tests, with `PENDING` empty — the migration is now enforced repo-wide.

- [ ] **Step 5: Build the affected packages**

Run: `pnpm --filter @gadgets/gatekeeper-context build && pnpm --filter @gadgets/gatekeeper-scheduler build && pnpm --filter @gadgets/mcp-shared build`
Expected: all build.

- [ ] **Step 6: Lint and commit**

Run: `pnpm lint`
Expected: PASS.

```bash
git add packages/mcp-shared packages/gatekeeper-context packages/gatekeeper-scheduler scripts/legacy-palette.test.js
git commit -m "feat: re-theme server-rendered OAuth pages and gatekeeper apps"
```

---

## Task 10: Product identity

Separated because it alone reaches `workshop-shared` and the backend, both of which are held to the kernel review bar in `AGENTS.md`. Keep this diff to the constant, the test, and the two asset references.

**Files:**
- Modify: `packages/workshop-shared/src/api.ts:674`
- Modify: `packages/workshop-frontend/index.html`
- Replace: `packages/workshop-frontend/public/favicon.svg`
- Modify: whichever backend test pins the OpenRouter `X-Title` (find it in Step 2)

**Interfaces:**
- Consumes: `packages/workshop-frontend/public/contentstack-logo.svg`, already committed.
- Produces: `DEFAULT_SITE_NAME === 'Contentstack OS'`, consumed by `resolveSiteName()` in `workshop-shared` and by `OPENROUTER_APP_TITLE` in `workshop-backend/src/ai-models.ts:351`.

- [ ] **Step 1: Locate the tests that pin the old name**

Run:

```bash
grep -rn "Cloudflare OS\|DEFAULT_SITE_NAME\|X-Title" packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "\.wrangler"
```

Note every hit. At minimum this covers `workshop-shared/src/api.ts`, `workshop-backend/src/ai-models.ts`, and the backend test added by commit `6e381c2`.

- [ ] **Step 2: Update the test expectations first**

In each test found in Step 1 that asserts `'Cloudflare OS'`, change the expected value to `'Contentstack OS'`. Do **not** skip or delete any of them.

- [ ] **Step 3: Run those tests to verify they fail**

Run: `cd packages/workshop-backend && pnpm test`
Expected: FAIL — the `X-Title` assertion reports the received value as `Cloudflare OS`.

- [ ] **Step 4: Rename the constant**

In `packages/workshop-shared/src/api.ts`, line 674 — change only the value, preserving the existing doc comment above it:

```ts
export const DEFAULT_SITE_NAME = "Contentstack OS";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/workshop-backend && pnpm test`
Expected: PASS.

Run: `cd packages/workshop-shared && pnpm test`
Expected: PASS (or "no tests", which is fine).

- [ ] **Step 6: Update the document title**

In `packages/workshop-frontend/index.html`:

```html
    <title>Contentstack OS</title>
```

- [ ] **Step 7: Swap the favicon**

Replace the contents of `packages/workshop-frontend/public/favicon.svg` with the contents of `packages/workshop-frontend/public/contentstack-logo.svg`:

```bash
cp packages/workshop-frontend/public/contentstack-logo.svg packages/workshop-frontend/public/favicon.svg
```

The existing `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` in `index.html` needs no change, because the replacement is also an SVG.

- [ ] **Step 8: Full verification**

Run: `pnpm lint`
Expected: PASS.

Run: `pnpm test`
Expected: PASS.

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/workshop-shared/src/api.ts packages/workshop-backend packages/workshop-frontend/index.html packages/workshop-frontend/public
git commit -m "feat: rename the product to Contentstack OS and ship the Contentstack mark"
```

---

## Task 11: Manual visual verification

Token changes cannot be unit-tested for taste, only for contrast — and contrast tests cannot see a control that has vanished into its background. This task has no code.

**Files:** none.

- [ ] **Step 1: Start the app**

Run: `pnpm dev-server` in one terminal and `pnpm dev-client` in another. Open `http://localhost:3000`.

- [ ] **Step 2: Walk every surface in light mode**

Visit and inspect: home / prompt, chat, the gadget editor (Monaco), a code diff, the gadget use view, admin (including the accent picker), connections, blueprints, login and signup, plus the two gatekeeper apps (`/gatekeepers/context`, `/gatekeepers/scheduler`).

For each, confirm: no warm-orange or warm-grey survives; every border is visible; no text is illegible; corners look consistent.

- [ ] **Step 3: Repeat in dark mode**

Toggle the theme and repeat Step 2. Pay particular attention to the diff viewer, banners on their tint backgrounds, and badges.

- [ ] **Step 4: Verify the accent override still works**

In admin, pick each preset and confirm the UI re-tints in both modes and that primary-button label text stays legible. Then set a deliberately pale custom colour (`#ffd400`) and confirm the dark-mode button is still readable — this is the clamp from Task 6 doing its job. Clear the override and confirm it returns to `#6c5ce7`.

- [ ] **Step 5: Check the logo**

Confirm the favicon renders in the browser tab and the mark appears correctly in the top bar. Note whether the logo's `#7c4dff` against the brand's `#6c5ce7` reads as intentional or as a mistake, and report back — per **A4** in the spec, recolouring the mark is a brand decision that was deliberately left open.

- [ ] **Step 6: Report**

Summarise anything that looked wrong. Do not fix issues silently; surface them so the token change and any component-level fix stay separable.

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|---|---|
| D1 token-level re-skin, no component rewrites | All — no `.tsx` restructuring anywhere |
| D2 dark mode kept, derived | 4 |
| D3 colour/radius/elevation only | 3, 4, 5; type and spacing guarded by a test in 2 |
| D4 all three surfaces | 2, 9 |
| D5 dark brand split | 4, 6 |
| D6 dark status colours | 4 |
| D7 `Contentstack OS` | 10 |
| D8 fonts unchanged | Guarded — `tokens.css` must not define font tokens (Task 2 Step 1) |
| D9 shared token package | 2 |
| Light tokens verbatim from Venus | 3 |
| Line-token translucency defect | 3 |
| `accentVars()` clamp defect | 6 |
| Radius full ramp (A3) | 5 |
| Elevation ramp + `.themed-*` | 5 |
| Monaco + `CodeDiffEditor.css` | 7 |
| `MeshBackground`, `AdminPage`, hex audit | 8 |
| `mcp-shared/html.ts`, gatekeeper pages | 9 |
| Rename blast radius incl. `X-Title` test | 10 |
| Logo/favicon (A1) | 10 |
| Vendor brand colours preserved | Global Constraints; enforced in 8 Step 3 |
| Measured-contrast section | 3, 4 as executable tests |
| Manual walkthrough | 11 |

No gaps.

**Placeholder scan:** Clean. No TBDs, no "handle edge cases", no "similar to Task N" — every code step carries the literal content to apply.

**Type consistency:** `lightBlock()`, `darkBlock()`, `token()` and `contrast()` are defined in Task 2/3 and reused by the same names in Tasks 4 and 5. `asHex()` and `oklchToLinear()` are defined and used only in Task 4. `PENDING` keeps its name across Tasks 1, 2, 5, 6, 7 and 9. `DEFAULT_ACCENT_COLOR` and `applyAccentColor` match their existing exports in `theme.ts`.

**Known coverage limit:** the ratchet cannot see `MeshBackground`'s RGB integers or the admin presets, because neither uses a legacy hex literal. Task 8 verifies those by inspection, and this is stated in that task rather than left implicit.
