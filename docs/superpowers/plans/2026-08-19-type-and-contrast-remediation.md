# Type and Contrast Remediation Implementation Plan

> **Status: executed and merged into `fix/type-and-contrast-remediation` (29 commits).** This plan
> is the historical argument, not the current state. It was amended 39 times during execution —
> read the spec's "Amendments made during execution" section before trusting any figure here. In
> particular: Task 7 became four dispatches rather than one, `text-ui-3xl` shipped at 30/36 rather
> than 28/34, and this plan's `inactive` exemption rule was itself the defect that let nine enabled
> controls ship at 2.48:1.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the deferred half of the Venus re-skin — make every content colour clear WCAG AA, replace thirteen ad-hoc font sizes with one scale, ship a typeface that actually loads, and gate all three against recurrence.

**Architecture:** Values change in `packages/design-tokens/tokens.css`; usage changes are Tailwind class-string edits in `packages/workshop-frontend`. No component restructuring. Each change is preceded by a mechanical guard in `scripts/design-tokens.test.js` that must be observed failing first, following the ratchet pattern already established by `scripts/legacy-palette.test.js`.

**Tech Stack:** Tailwind v4 `@theme`, Kumo semantic tokens, `node:test`, vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-19-type-and-contrast-remediation-design.md`

## Global Constraints

- **pnpm only.** Never npm. `pnpm lint` = `lint:check` (oxlint) + `types:check` (recursive `tsc --noEmit`).
- **Never rename a `--text-color-kumo-*` or `--color-kumo-*` token.** Kumo's compiled `dist/` consumes these names. Values only. (Spec T3)
- **Never change `--color-kumo-brand`.** Brand *fills* stay `#6c5ce7`; only brand-as-text moves. (Spec T8)
- **Never touch the `[data-mode="dark"]` ramp.** It already measures 15.52 / 7.34 / 4.58 and needs no work. (Spec T9)
- **Leave `--text-xs` / `--text-sm` / `--text-base` / `--text-lg` in `styles.css` defined exactly as they are.** They serve Kumo's compiled components, not us. App code moves to `text-ui-*`. (Spec T5)
- **Negative letter-spacing only above 18px.** (Spec T6)
- **No AI/LLM attribution or `Co-Authored-By` in any commit message.** (CLAUDE.md)
- **Contrast targets:** content text ≥ 4.5:1 against `#ffffff`, `--color-kumo-elevated` and `--color-kumo-tint`. `inactive` must stay *below* 4.5:1 — a disabled control that reads as enabled is its own defect.
- **Live review gate.** The author has frontend and backend running. Every task ends by stopping for a live look before the next begins. Do not batch tasks.

## Branch

This work does not belong on `feat/explicit-workspace-creation`. Before Task 1:

```bash
git checkout main && git pull && git checkout -b fix/type-and-contrast-remediation
```

---

### Task 1: Token guard harness + declare the six undeclared Kumo tokens

Kumo's `dist/` references 16 `--text-color-kumo-*` names. `tokens.css` declares 10 of them, so six fall back to Kumo's unbranded defaults — including `--text-color-kumo-badge-orange-subtle`, a literal orange, in a re-skin whose stated success criterion was "no warm-orange survives." (The "57 badge uses" figure this plan originally cited did not survive verification — see the spec's amendment note.)

**Files:**
- Create: `scripts/design-tokens.test.js`
- Modify: `packages/design-tokens/tokens.css` (the `@theme` TEXT block, currently lines 52–64)

**Interfaces:**
- Consumes: nothing.
- Produces: `scripts/design-tokens.test.js`, plus two module-level helpers later tasks build on — `ROOT`, `TOKENS` and `KUMO_DIST` path constants, and `lightTheme()` returning a `Map<string,string>` of every custom property in the light `@theme` block. Task 2 adds `contrast(a, b)`; Task 3 adds `tsxFiles(dir)`, `repoPath(file)` and `SKIP_DIRS`. Nothing named `SURFACES` or `sourceFiles` exists — surfaces are read inline from `lightTheme()` at each use.

- [ ] **Step 1: Write the failing completeness test**

Create `scripts/design-tokens.test.js`:

```js
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
  const missing = [...referenced].filter((t) => !declared.has(t)).sort()
  assert.deepEqual(missing, [], 'declare these in packages/design-tokens/tokens.css')
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --test scripts/design-tokens.test.js
```

Expected: FAIL, listing exactly these six:
`--text-color-kumo-badge-inverted`, `--text-color-kumo-badge-neutral-subtle`,
`--text-color-kumo-badge-orange-subtle`, `--text-color-kumo-badge-teal-subtle`,
`--text-color-kumo-info`, `--text-color-kumo-placeholder`.

If the list differs, stop and report — the Kumo version may have moved.

- [ ] **Step 3: Declare the six tokens**

In `packages/design-tokens/tokens.css`, inside the `@theme` TEXT block, after
`--text-color-kumo-warning: #704b00;`:

```css
  /* Placeholders are measured to sit only on `base` or a transparent parent, never on `tint`:
     4.94:1 on base, 4.60:1 on elevated. Do not put a placeholder on a tinted surface. */
  --text-color-kumo-placeholder: #66708a;
  /* Kumo's own fallback is a generic blue; this is the Venus aqua darkened to clear AA. */
  --text-color-kumo-info: #0057c2;
  /* Badge text. Undeclared, these fell back to Kumo's neutrals — and, for `orange`, to a literal
     orange, which is exactly the colour the Venus re-skin removed. */
  --text-color-kumo-badge-orange-subtle: #704b00;
  --text-color-kumo-badge-teal-subtle: #1f6f78;
  --text-color-kumo-badge-neutral-subtle: #5b6580;
  --text-color-kumo-badge-inverted: #ffffff;
```

Add the dark-mode counterparts in the `[data-mode="dark"]` block. This is *adding* dark tokens that
never existed, not retuning the dark ramp, so it does not conflict with T9:

```css
  --text-color-kumo-placeholder: oklch(0.62 0.02 285);
  --text-color-kumo-info: #74b4ff;
  --text-color-kumo-badge-orange-subtle: #ffbc36;
  --text-color-kumo-badge-teal-subtle: #6fd3dd;
  --text-color-kumo-badge-neutral-subtle: oklch(0.7 0.02 285);
  --text-color-kumo-badge-inverted: oklch(0.15 0.015 285);
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node --test scripts/design-tokens.test.js
pnpm lint
```

Expected: both PASS. `pnpm lint` shows only the pre-existing `unicorn`/`no-shadow` warnings.

- [ ] **Step 5: Live review gate — STOP**

Ask the author to look at any screen with a badge (Blueprints cards, Outputs status chips) and at
any empty input, in both modes. Expected visible change: badge text is no longer orange;
placeholder text picks up the Venus blue-grey hue instead of a flat neutral grey. Nothing else
should move. Wait for confirmation before Step 6.

- [ ] **Step 6: Commit**

```bash
git add scripts/design-tokens.test.js packages/design-tokens/tokens.css
git commit -m "fix(tokens): declare the six undeclared Kumo text tokens

Kumo's dist references 16 --text-color-kumo-* names; we declared 10, so six
fell back to Kumo's unbranded defaults. badge-orange-subtle resolved to a
literal orange, and placeholder to a hueless grey in
every Kumo input.

Adds scripts/design-tokens.test.js with a completeness guard so an
undeclared token fails CI rather than shipping a stray colour."
```

---

### Task 2: Retune the light content ramp

`subtle` clears AA on white by 0.09 and fails on `tint` — the hover surface, so contrast degrades exactly when a row is being read. `inactive` fails everywhere. Light mode sits roughly one rung paler than dark at every step.

**Files:**
- Modify: `scripts/design-tokens.test.js` (add the contrast test)
- Modify: `packages/design-tokens/tokens.css` (`@theme` TEXT block)

**Interfaces:**
- Consumes: `lightTheme()` from Task 1.
- Produces: `contrast(a, b)`, and the `CONTENT_TOKENS` list. No later task consumes them; they stay in this file.

- [ ] **Step 1: Write the failing contrast test**

Append to `scripts/design-tokens.test.js`:

```js
const channel = (c) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
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
```

- [ ] **Step 2: Run and confirm it fails**

```bash
node --test scripts/design-tokens.test.js
```

Expected FAIL with exactly these four entries, in this order — this output has been verified by
running the test against a simulated post-Task-1 `tokens.css`:

```
--text-color-kumo-subtle on elevated: 4.35
--text-color-kumo-subtle on tint: 4.05
--text-color-kumo-link on tint: 4.29
--text-color-kumo-brand on tint: 4.29
```

The `inactive` and `placeholder` tests should already PASS (`#66708a` comes from Task 1; `#a9b6cb`
is far below AA). If the list differs, a token moved since this plan was written — stop and report
rather than adjusting the expectation.

- [ ] **Step 3: Retune the ramp**

In the `@theme` TEXT block, replace the four content rungs and three brand/status values. Keep the
existing `warning` comment; add the role comments:

```css
  /* ===== TEXT =====
     Three content rungs and one disabled rung. There is no room on white for four passing greys —
     measurement puts the ceiling at three — so `inactive` is reserved for genuinely disabled
     controls and must never carry content. Ratios are against base / elevated / tint.

     Deviates from Venus deliberately (spec T1): Venus's font-base, font-secondary and font-tertiary
     are 8.02 / 4.59 / 2.05 on white, and the latter two fail on our tint surface. */
  --text-color-kumo-default: #3d4658;        /* 9.48 / 8.82 / 8.14 — body, nav, row titles */
  --text-color-kumo-default-hover: #212121;
  --text-color-kumo-inverse: #ffffff;
  --text-color-kumo-strong: #1c2333;         /* 15.70 / 14.61 / 13.48 — headings, titles */
  --text-color-kumo-subtle: #5b6580;         /* 5.80 / 5.40 / 4.98 — captions, metadata, eyebrows */
  --text-color-kumo-inactive: #9aa5ba;       /* 2.48 — DISABLED CONTROLS ONLY. Not placeholders,
                                                not timestamps, not labels. See tests. */
  --text-color-kumo-brand: #5b48d9;          /* 6.22 — brand as *text*; fills stay #6c5ce7 */
  --text-color-kumo-link: #5b48d9;
  --text-color-kumo-success: #006946;        /* 6.75 */
  --text-color-kumo-danger: #c92000;         /* 5.69 */
  --text-color-kumo-warning: #704b00;        /* 7.79 — Venus attention-dark; #ffae0a is 1.86 */
```

`--text-color-kumo-strong` moves off Venus's flat `#222222` to keep headings in the ramp's
blue-grey hue family rather than reading as a separate black.

Note which of these the test actually forced: only `subtle`, `link` and `brand` were failing.
`danger` (4.51) and `success` (4.74) cleared AA on the old tint by a hair, and are lifted here for
headroom — Task 4 darkens `tint`, which would push them under. `strong` and `default` already
passed; they move for hierarchy and crispness, not compliance. Stating this so the next reader
does not assume every value in this block was test-driven.

Also update the two custom foreground aliases so they don't contradict the ramp:

```css
  --color-foreground-100: #1c2333;
  --color-foreground-300: #3d4658;
```

- [ ] **Step 4: Run and confirm it passes**

```bash
node --test scripts/design-tokens.test.js && pnpm lint
```

Expected: PASS. These values have been verified to pass under Task 4's darker surfaces as well as
today's, so Task 4 cannot break this guard.

- [ ] **Step 5: Live review gate — STOP**

This is the change that answers "everything looks faded." Ask the author to look at Home, a chat,
and Blueprints in **light** mode. Expected: body text and captions visibly crisper; the Home
headline still grey (it is wired to `default`, and Task 3 moves it to `strong`). Dark mode should
look **identical** to before — if it changed, the dark block was edited by mistake. Wait for
confirmation.

- [ ] **Step 6: Commit**

```bash
git add scripts/design-tokens.test.js packages/design-tokens/tokens.css
git commit -m "fix(tokens): retune the light text ramp to clear AA on every surface

subtle cleared AA on white by 0.09 and failed at 4.05 on tint — the hover
surface — so contrast degraded exactly while a row was being read. Light mode
sat roughly one rung paler than dark at every step.

Collapses to three content rungs plus a disabled-only inactive, and lifts
brand/status text. Brand fills are untouched. Adds computed contrast guards so
a failing value cannot be committed again."
```

---

### Task 3: Migrate `inactive` misuse and restore the heading hierarchy

`text-kumo-inactive` appears 212 times; about ten concern disabled state. The rest carry content. Separately, `strong` is used 40 times against 643 uses of `subtle`/`inactive`, and the 30px Home headline is set to a body grey — so nothing on the page sits at heading contrast.

**Files:**
- Modify: `scripts/design-tokens.test.js` (add the ratchet)
- Modify: ~60 files under `packages/workshop-frontend/src/` (class strings only)
- Key sites: `routes/index.tsx:153` (Home `h1`), `components/AppShell/Sidebar.tsx:69` (wordmark), `components/AppShell/SidebarWorkspaces.tsx:421,505`, `components/AppShell/HomeTaskSuggestions.tsx:111,114,147`

**Interfaces:**
- Consumes: `ROOT` from Task 1.
- Produces: `SKIP_DIRS`, `tsxFiles(dir)` and `repoPath(file)` — modelled on the equivalents in `scripts/legacy-palette.test.js` — plus a `PENDING_INACTIVE` set that Tasks 7 and 9 depend on.

- [ ] **Step 1: Write the failing ratchet test**

Append to `scripts/design-tokens.test.js`:

```js
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

// Files still using `text-kumo-inactive` for something other than a disabled control. Shrinks only.
// Populate in Step 2 from the actual failure output; do not guess.
const PENDING_INACTIVE = new Set([])

test('text-kumo-inactive is not used for content outside the pending allowlist', () => {
  const offenders = []
  for (const file of tsxFiles(join(ROOT, 'packages/workshop-frontend/src'))) {
    const rel = repoPath(file)
    if (PENDING_INACTIVE.has(rel)) continue
    if (readFileSync(file, 'utf8').includes('text-kumo-inactive')) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], 'move these to subtle/placeholder, or add to PENDING_INACTIVE')
})

test('the inactive allowlist has no stale entries', () => {
  const stale = [...PENDING_INACTIVE].filter(
    (rel) => !readFileSync(join(ROOT, rel), 'utf8').includes('text-kumo-inactive'),
  )
  assert.deepEqual(stale, [], 'these are clean — remove them from PENDING_INACTIVE')
})
```

- [ ] **Step 2: Run it, then seed the allowlist from the real output**

```bash
node --test scripts/design-tokens.test.js 2>&1 | grep 'packages/workshop-frontend'
```

Paste every reported path into `PENDING_INACTIVE`, then re-run and confirm PASS. The ratchet now
records the debt precisely; the rest of this task pays it down.

- [ ] **Step 3: Migrate content uses to `subtle`, removing each file from PENDING_INACTIVE as you go**

Work file by file. For each occurrence decide by role, not by appearance:

| Occurrence is… | Becomes |
|---|---|
| an uppercase section label (`FAVORITES`, `GET STARTED`, `RECENT WORKSPACES`) | `text-kumo-subtle` |
| `placeholder:text-kumo-inactive` | `placeholder:text-kumo-placeholder` |
| a caption, timestamp, file name, monogram, or empty-state sentence | `text-kumo-subtle` |
| a decorative chevron/caret or an icon beside already-labelled text | `text-kumo-subtle` |
| genuinely a disabled control (`disabled` prop or `aria-disabled` on the same element) | leave as `text-kumo-inactive`, keep the file in PENDING_INACTIVE |

Concrete anchors:

- `components/AppShell/SidebarWorkspaces.tsx:505` — `text-kumo-inactive` → `text-kumo-subtle`
- `components/AppShell/SidebarWorkspaces.tsx:421` — empty state → `text-kumo-subtle`
- `components/AppShell/SidebarWorkspaces.tsx:418` — the `Star` icon → `text-kumo-subtle`
- `components/AppShell/HomeTaskSuggestions.tsx:147` — "Get started" → `text-kumo-subtle`
- `components/SectionEyebrow.tsx:9` — count badge → `text-kumo-subtle`
- All 19 `placeholder:text-kumo-inactive` → `placeholder:text-kumo-placeholder`

- [ ] **Step 4: Restore the heading hierarchy**

Move each of these from `text-kumo-default` to `text-kumo-strong`:

- `routes/index.tsx:153` — the Home `h1`
- `components/AppShell/Sidebar.tsx:69` — the "Contentstack OS" wordmark
- `components/AppShell/HomeTaskSuggestions.tsx:111` — the suggestion row label
- Card titles in `components/BlueprintCard.tsx`, `components/GadgetList.tsx`, `components/RecentApps.tsx`
- Dialog titles in `components/CreateWorkspaceDialog.tsx`, `components/DeleteConfirmationDialog.tsx`

Then discharge the other deferred instruction from the 2026-08-06 spec — *"where body copy sits in
`subtle` on a `tint` background, it moves to `default`"*. Find the candidates:

```bash
cd packages/workshop-frontend/src
grep -rn "bg-kumo-tint" --include='*.tsx' . | grep "text-kumo-subtle"
```

Move any that is a sentence of prose (not a label or a chip) to `text-kumo-default`.

- [ ] **Step 5: Verify**

```bash
cd /Users/pradeep.mishra/Documents/GitHub/work/contentstack-os
node --test scripts/design-tokens.test.js && pnpm lint && pnpm --filter @gadgets/workshop-frontend test
```

Expected: PASS, with `PENDING_INACTIVE` now holding only genuine disabled-state files.

- [ ] **Step 6: Live review gate — STOP**

Ask the author to check: the Home headline and sidebar wordmark now read as headings; `FAVORITES` /
`RECENT WORKSPACES` / `GET STARTED` are legible rather than ghosted; placeholders look intentional;
and — importantly — every genuinely disabled button still *looks* disabled. Wait for confirmation.

- [ ] **Step 7: Commit**

```bash
git add scripts/design-tokens.test.js packages/workshop-frontend/src
git commit -m "fix(ui): stop using the disabled-state colour for content

text-kumo-inactive is 2.05:1 and, in Kumo's vocabulary, means a control the
user cannot operate. It was used 212 times, of which about ten were disabled
state; the rest were section labels, placeholders, timestamps, captions and
empty-state prose.

Also restores the heading hierarchy — the 30px Home headline, the wordmark and
card titles were all set to a body grey, so nothing sat at heading contrast —
and moves prose off subtle-on-tint, discharging the follow-up recorded in the
2026-08-06 design.

Adds a ratchet guard so the misuse cannot silently return."
```

---

### Task 4: Surfaces and hairline

Base-to-elevated is 1.055:1 and the hairline resolves to 1.20:1, so panel edges and card borders barely register — a flatness that reads as washed-out independently of text colour. Isolated per spec T10 because `tint` is 157 hover states: this is the widest blast radius in the plan and the most likely single revert.

**Files:**
- Modify: `packages/design-tokens/tokens.css` (`@theme` VENUS SURFACES and LINES blocks)

**Interfaces:**
- Consumes: the contrast test from Task 2, which reads `elevated` and `tint` dynamically and so re-validates the whole ramp against the new surfaces automatically.
- Produces: nothing new.

- [ ] **Step 1: Change the three surface values**

```css
  --color-kumo-elevated: #f4f7fb;   /* was #f7f9fc — 1.055:1 against base was invisible */
  --color-kumo-tint: #e9eef6;       /* was #edf1f7 */
  --color-kumo-fill: #e9eef6;
```

And in the LINES block:

```css
  /* Venus font-base at 20%, not 12%: at 12% the hairline was 1.20:1 on elevated, so panel and card
     edges did not register. Still translucent, because `recessed` and `fill-hover` share a value
     and a solid line would vanish on them. */
  --color-kumo-line: #47516133;
```

Keep `--color-background-200` / `-300` in step with `elevated` / `tint`:

```css
  --color-background-200: #f4f7fb;
  --color-background-300: #e9eef6;
```

Leave `--color-kumo-fill-hover`, `--color-kumo-recessed` and `--color-kumo-interact` alone.

- [ ] **Step 2: Confirm the ramp still passes against the darker surfaces**

```bash
node --test scripts/design-tokens.test.js
```

Expected: PASS. The Task 2 test reads the surfaces from the file, so this is a genuine re-check —
darkening `tint` lowers every text-on-tint ratio. If `subtle on tint` now fails, `tint` went too
dark; revert to `#e9eef6` exactly.

- [ ] **Step 3: Live review gate — STOP**

Ask the author to look at the sidebar/canvas boundary, card borders, table row hover, and any
dropdown. Expected: edges now visible, hover states slightly more present. This is the most
subjective change in the plan — if it reads as heavy rather than defined, revert this commit alone
and continue with Task 5. Wait for confirmation.

- [ ] **Step 4: Commit**

```bash
git add packages/design-tokens/tokens.css
git commit -m "fix(tokens): give surfaces and hairlines enough separation to register

base-to-elevated was 1.055:1 and the hairline 1.20:1, so the sidebar edge and
every card border were effectively invisible — flatness that reads as
washed-out regardless of text colour.

Kept as its own commit: tint is 157 hover states, so this is the widest blast
radius in the remediation and the most likely thing to want reverting alone."
```

---

### Task 5: Ship Inter, remove the phantom families, drop `antialiased`

`--font-sans` names `"FT Kunst Grotesk"` with no `@font-face`, no font file, and no dependency anywhere in the repo. It arrived in `5c58306` ("Update frontend to use Tanstack and Kumo") — it is Cloudflare's brand font, inherited from the fork and never licensed. Every user has been rendering in `-apple-system` or Segoe UI. `"Apercu Mono Pro"` is the same story.

**Files:**
- Create: `packages/workshop-frontend/public/fonts/InterVariable.woff2`
- Create: `packages/workshop-frontend/public/fonts/LICENSE-Inter.txt`
- Modify: `packages/workshop-frontend/src/styles.css`
- Modify: `packages/workshop-frontend/index.html`
- Modify: `scripts/legacy-palette.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the `Inter Variable` family name, referenced by `--font-sans`.

- [ ] **Step 1: Add the font and its licence**

A verified copy is already downloaded at
`/private/tmp/claude-502/-Users-pradeep-mishra-Documents-GitHub-work-contentstack-os/7a916d19-00d1-4f29-b824-bd81bf64dabf/scratchpad/InterVariable.woff2`
(352,240 bytes, WOFF2 v4.66). Otherwise re-fetch from `https://rsms.me/inter/font-files/InterVariable.woff2`.

```bash
mkdir -p packages/workshop-frontend/public/fonts
cp "/private/tmp/claude-502/-Users-pradeep-mishra-Documents-GitHub-work-contentstack-os/7a916d19-00d1-4f29-b824-bd81bf64dabf/scratchpad/InterVariable.woff2" \
   packages/workshop-frontend/public/fonts/InterVariable.woff2
curl -sS -o packages/workshop-frontend/public/fonts/LICENSE-Inter.txt \
  "https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt"
```

Inter is SIL Open Font License 1.1; the licence file must ship alongside the font.

- [ ] **Step 2: Declare the face and repoint the stacks**

At the very top of `packages/workshop-frontend/src/styles.css`, above the existing `@source` line
(`@font-face` must precede the `@theme` that references the family):

```css
/* Inter Variable, self-hosted. The stack previously named "FT Kunst Grotesk" — Cloudflare's brand
   font, inherited from the fork in 5c58306 and never licensed, so it never loaded and every user
   rendered in the system fallback. Preloaded in index.html so `swap` is imperceptible. */
@font-face {
  font-family: "Inter Variable";
  src: url("/fonts/InterVariable.woff2") format("woff2-variations");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
```

Then in the `@theme` block:

```css
  --font-sans: "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI",
    "Roboto", "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace;
```

- [ ] **Step 3: Drop `antialiased` from `body`**

`antialiased` expands to `-webkit-font-smoothing: antialiased`, which on macOS disables subpixel
rendering and thins every glyph — a contrast loss on top of a ramp that was already too pale.
Change:

```css
body {
  @apply m-0;
  font-family: var(--font-sans);
  background-color: var(--color-kumo-base);
  color: var(--text-color-kumo-default);
}
```

- [ ] **Step 4: Preload the font**

In `packages/workshop-frontend/index.html`, after the `<meta name="viewport">` line:

```html
    <link rel="preload" href="/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin />
```

- [ ] **Step 5: Lock out the phantom families**

In `scripts/legacy-palette.test.js`, add to the `LEGACY` array with a comment:

```js
  // Cloudflare-era typefaces. Named in --font-sans/--font-mono but never licensed, shipped or
  // loaded, so the product silently rendered in the system fallback.
  'FT Kunst Grotesk', 'Apercu Mono Pro',
```

`legacyHits` lowercases the file before matching, so these entries must be lowercase to match:
use `'ft kunst grotesk'` and `'apercu mono pro'`.

- [ ] **Step 6: Verify**

```bash
node --test scripts/legacy-palette.test.js
pnpm --filter @gadgets/workshop-frontend build
```

Expected: the palette guard PASSES (its own file is already in `PENDING`, which covers the new
literals living in its `LEGACY` array). The build emits `InterVariable.woff2` into `dist/fonts/`.
Confirm:

```bash
ls packages/workshop-frontend/dist/fonts/
```

- [ ] **Step 7: Live review gate — STOP**

Hard refresh. Ask the author to confirm the app is now in Inter, not SF Pro — the easiest tell is
the lowercase `a` and the flat-topped `t`. Every label should read slightly larger and heavier at
the same pixel size, because Inter's x-height is greater. No sizes have changed yet. Wait for
confirmation.

- [ ] **Step 8: Commit**

```bash
git add packages/workshop-frontend/public/fonts packages/workshop-frontend/src/styles.css \
        packages/workshop-frontend/index.html scripts/legacy-palette.test.js
git commit -m "feat(ui): ship Inter Variable instead of a font that never loaded

--font-sans named FT Kunst Grotesk with no @font-face, no font file and no
dependency anywhere in the repo. It came from the Cloudflare fork in 5c58306
and was never licensed, so every user rendered in -apple-system or Segoe UI.
Apercu Mono Pro was the same.

Self-hosts Inter Variable under the OFL with its licence, preloads it, and
drops the antialiased utility from body — on macOS it disabled subpixel
rendering and thinned every glyph. Adds both phantom families to the legacy
palette guard."
```

---

### Task 6: Add the `text-ui-*` scale

Additive only — nothing consumes it yet, so this task has no visual effect. Isolated so that Task 7's reflow is the only thing under review when it lands.

**Files:**
- Modify: `packages/workshop-frontend/src/styles.css` (`@theme`)

**Interfaces:**
- Produces: `text-ui-2xs`, `text-ui-xs`, `text-ui-sm`, `text-ui-md`, `text-ui-lg`, `text-ui-xl`, `text-ui-2xl`, `text-ui-3xl` — the exact class names Task 7 migrates onto.

- [ ] **Step 1: Add the scale**

In the `@theme` block of `styles.css`, replacing the existing TEXT SIZES comment:

```css
  /* ===== TYPE SCALE =====
     One scale for our own code. Thirteen ad-hoc pixel sizes (9/10/11/12/13/14/15/17/18/20/28/30/34)
     previously ran alongside Tailwind's named scale, so raising nav text was a 163-literal search
     rather than a token edit.

     Deliberately a separate `ui` namespace: Tailwind's --text-xs/-sm/-base/-lg are load-bearing
     twice over. The block below restores Tailwind's defaults over Kumo's, AND Kumo's own compiled
     components resolve against them via the @source scan — so text-sm means 14/20 to 133 of our
     call sites and to every Kumo component. Re-pointing it would silently shrink both.
     DO NOT "tidy away" the --text-* block. It exists for Kumo. */
  --text-xs: 0.75rem;
  --text-xs--line-height: 1rem;
  --text-sm: 0.875rem;
  --text-sm--line-height: 1.25rem;
  --text-base: 1rem;
  --text-base--line-height: 1.5rem;
  --text-lg: 1.125rem;
  --text-lg--line-height: 1.75rem;

  /* Ours. Negative tracking only above 18px — below that the faces we ship already tighten
     optically, and the old blanket tracking-[-0.25px] on 13px text double-counted it. */
  --text-ui-2xs: 0.6875rem;            /* 11px — uppercase eyebrows and badges only */
  --text-ui-2xs--line-height: 1rem;
  --text-ui-2xs--letter-spacing: 0.06em;
  --text-ui-2xs--font-weight: 600;
  --text-ui-xs: 0.75rem;               /* 12px — captions, metadata, timestamps */
  --text-ui-xs--line-height: 1rem;
  --text-ui-sm: 0.8125rem;             /* 13px — dense UI: chips, table cells */
  --text-ui-sm--line-height: 1.125rem;
  --text-ui-md: 0.875rem;              /* 14px — default body and nav */
  --text-ui-md--line-height: 1.25rem;
  --text-ui-lg: 0.9375rem;             /* 15px — prose, chat messages */
  --text-ui-lg--line-height: 1.375rem;
  --text-ui-xl: 1.125rem;              /* 18px — card and section titles */
  --text-ui-xl--line-height: 1.625rem;
  --text-ui-xl--letter-spacing: -0.01em;
  --text-ui-2xl: 1.375rem;             /* 22px — subsection headings */
  --text-ui-2xl--line-height: 1.75rem;
  --text-ui-2xl--letter-spacing: -0.015em;
  --text-ui-3xl: 1.75rem;              /* 28px — page headings */
  --text-ui-3xl--line-height: 2.125rem;
  --text-ui-3xl--letter-spacing: -0.02em;
```

- [ ] **Step 2: Prove the utilities generate**

Add `text-ui-md` temporarily to the Home `h1` in `routes/index.tsx`, confirm in the browser that
computed font-size is 14px, then remove it. This verifies Tailwind picked up the namespace before
Task 7 depends on 730 uses of it.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @gadgets/workshop-frontend build && pnpm lint
git add packages/workshop-frontend/src/styles.css
git commit -m "feat(ui): add the text-ui-* type scale

Eight steps replacing thirteen ad-hoc pixel sizes. Additive: nothing consumes
it yet, so there is no visual change.

Namespaced rather than redefining Tailwind's text-xs/-sm/-base/-lg, which are
load-bearing twice over — styles.css restores Tailwind's defaults over Kumo's,
and Kumo's compiled components resolve against them, so text-sm means 14/20 to
133 of our call sites and to every Kumo component."
```

---

### Task 7: Migrate every sizing call site onto the scale

~730 call sites: the ~490 pixel literals plus the ~238 Tailwind-named uses. This is the only task in the plan that can reflow layout. If the diff becomes hard to review, split it by directory (`routes/`, `components/chat/`, `components/AppShell/`, everything else) into separate commits — the ratchet supports partial progress by design.

**Files:**
- Modify: `scripts/design-tokens.test.js` (add the ratchet)
- Modify: ~108 files under `packages/workshop-frontend/src/`

**Interfaces:**
- Consumes: the `text-ui-*` utilities from Task 6; `tsxFiles`, `repoPath`, `PENDING_INACTIVE` pattern from Task 3.
- Produces: a `PENDING_SIZES` set that Task 9 confirms is empty.

- [ ] **Step 1: Write the failing ratchet test**

Append to `scripts/design-tokens.test.js`:

```js
// Sizing must come from the text-ui-* scale. Bans ad-hoc pixel literals, Tailwind's bare names
// (which belong to Kumo now), and negative tracking at UI sizes.
const PENDING_SIZES = new Set([])

const BANNED_SIZE = /\btext-\[\d+px\]|\btext-(?:xs|sm|base|lg|xl|2xl|3xl)\b/
const BANNED_TRACKING = /\btracking-\[-[\d.]+px\]/

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
```

- [ ] **Step 2: Run it and seed `PENDING_SIZES` from the real output**

```bash
node --test scripts/design-tokens.test.js 2>&1 | grep 'packages/workshop-frontend'
```

Paste every path in, re-run, confirm PASS. The ratchet now holds the full debt.

- [ ] **Step 3: Apply the mechanical replacements**

Write `scripts/codemod-type-scale.mjs` as a throwaway (do not commit it):

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'packages/workshop-frontend/src'
// Unambiguous mappings only. text-[13px], text-[20px] and Tailwind's text-base/-xl/-2xl/-3xl are
// deliberately absent: they need a per-element decision and are handled by hand in Step 4.
const MAP = [
  [/\btext-\[9px\]/g,  'text-ui-2xs'],
  [/\btext-\[10px\]/g, 'text-ui-2xs'],
  [/\btext-\[11px\]/g, 'text-ui-2xs'],
  [/\btext-\[12px\]/g, 'text-ui-xs'],
  [/\btext-\[14px\]/g, 'text-ui-md'],
  [/\btext-\[15px\]/g, 'text-ui-lg'],
  [/\btext-\[17px\]/g, 'text-ui-xl'],
  [/\btext-\[18px\]/g, 'text-ui-xl'],
  [/\btext-\[22px\]/g, 'text-ui-2xl'],
  [/\btext-\[28px\]/g, 'text-ui-3xl'],
  [/\btext-\[30px\]/g, 'text-ui-3xl'],
  [/\btext-\[34px\]/g, 'text-ui-3xl'],
  [/\btext-xs\b/g,     'text-ui-xs'],
  [/\btext-sm\b/g,     'text-ui-md'],   // text-sm resolves to 14/20 today, not 13
  [/\btext-lg\b/g,     'text-ui-xl'],
  // Sub-18px negative tracking is removed, not translated (spec T6).
  [/\s*\btracking-\[-0\.25px\]/g, ''],
  [/\s*\btracking-\[-0\.2px\]/g, ''],
  [/\s*\btracking-\[-0\.1px\]/g, ''],
]

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.tsx')) out.push(p)
  }
  return out
}

let changed = 0
for (const file of walk(SRC)) {
  const before = readFileSync(file, 'utf8')
  let after = before
  for (const [re, to] of MAP) after = after.replace(re, to)
  if (after !== before) { writeFileSync(file, after); changed++ }
}
console.log(`rewrote ${changed} files`)
```

```bash
node scripts/codemod-type-scale.mjs && pnpm lint && rm scripts/codemod-type-scale.mjs
```

- [ ] **Step 4: Resolve the per-element cases by hand**

```bash
cd packages/workshop-frontend/src
grep -rn "text-\[13px\]\|text-\[20px\]\|text-base\b\|text-xl\b\|text-2xl\b\|text-3xl\b" --include='*.tsx' .
```

Decide each individually:

- `text-[13px]` (163) → `text-ui-sm`, **except** nav rows, workspace rows and body copy, which go to
  `text-ui-md`. When unsure, prefer `text-ui-md`: this whole change exists partly because the UI
  reads small.
- `text-[20px]` (3) → `text-ui-xl` if it labels a card, `text-ui-2xl` if it heads a section.
- `text-base` (5) → `text-ui-lg`. Note this drops 16px to 15px; check nothing wraps.
- `text-xl` (3), `text-2xl` (8), `text-3xl` (3) → `text-ui-2xl` or `text-ui-3xl` by role.

**Also strip the utilities that would fight the scale.** The `text-ui-*` steps carry their own
`line-height` and `letter-spacing`, but a sibling Tailwind utility has equal specificity and wins by
source order. Wherever a migrated element also carries `leading-*` or `tracking-tight` /
`tracking-tighter` / `tracking-normal`, remove it and let the scale supply the value:

```bash
grep -rn "text-ui-" --include='*.tsx' . | grep -E "leading-|tracking-(tight|tighter|normal|wide)"
```

The Home `h1` at `routes/index.tsx:153` is the clearest case — it carries both `tracking-tight` and
`leading-tight`, either of which would silently override `text-ui-3xl`.

Remove each file from `PENDING_SIZES` as it is finished.

- [ ] **Step 5: Verify**

```bash
cd /Users/pradeep.mishra/Documents/GitHub/work/contentstack-os
node --test scripts/design-tokens.test.js && pnpm lint && pnpm --filter @gadgets/workshop-frontend test
```

Expected: PASS, `PENDING_SIZES` empty.

- [ ] **Step 6: Live review gate — STOP**

The reflow check, and the longest one. Ask the author to walk **both** modes across home, chat,
workspace editor (Monaco), blueprints, outputs, connectors, admin and login, watching specifically
for: truncated labels, buttons wrapping to two lines, clipped table cells, and misaligned icon/text
baselines. Wait for confirmation, and expect follow-up adjustments here rather than a clean pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/design-tokens.test.js packages/workshop-frontend/src
git commit -m "refactor(ui): move every sizing call site onto the text-ui-* scale

Thirteen ad-hoc pixel sizes ran alongside Tailwind's named scale, so raising
nav text meant editing 163 string literals. All ~730 sizing call sites now
resolve through one scale.

Also drops blanket sub-18px negative letter-spacing: tracking-[-0.25px] was
applied to 13px text in 163 places, double-counting the optical tightening the
shipped faces already apply.

Adds a ratchet guard so neither convention can return."
```

---

### Task 8: Sidebar sizing

The specific complaint that opened this work: nav text at 13px with `-0.25px` tracking in a 260px rail. With Inter shipped, the darker ramp in place and tracking removed, this is the last axis.

**Files:**
- Modify: `packages/workshop-frontend/src/components/AppShell/SidebarItem.tsx:49-53`
- Modify: `packages/workshop-frontend/src/components/AppShell/SidebarGadgetRow.tsx:56-57,64,82`
- Modify: `packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx:505`
- Modify: `packages/workshop-frontend/src/components/AppShell/Sidebar.tsx:69`

**Interfaces:**
- Consumes: the `text-ui-*` scale.
- Produces: nothing.

- [ ] **Step 1: Raise the nav rows**

`SidebarItem.tsx` — `text-ui-sm` → `text-ui-md`, and `h-8` → `h-[34px]` so the 20px line-height
does not crowd:

```tsx
        'group relative flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-ui-md transition-colors',
```

- [ ] **Step 2: Raise the workspace rows**

`SidebarGadgetRow.tsx` — same treatment on both the base `className` and the `activeProps`
`className` (they are duplicated strings; both must change or the active row will jump), plus the
rename input on line 82. The monogram on line 64 goes to `text-ui-2xs`.

- [ ] **Step 3: Set the section labels and wordmark**

`SidebarWorkspaces.tsx:505` — the label becomes `text-ui-2xs` in `text-kumo-subtle`. The scale
already carries `uppercase`'s letter-spacing and weight 600, so drop the local
`text-[11px] font-medium tracking-[0.06em]`.

`Sidebar.tsx:69` — the wordmark becomes `text-ui-lg` and `text-kumo-strong`.

- [ ] **Step 4: Verify**

```bash
node --test scripts/design-tokens.test.js && pnpm lint
```

- [ ] **Step 5: Live review gate — STOP**

Ask the author whether the rail now reads correctly, and specifically whether "Context & Skills"
still fits without truncating at 14px in a 260px rail. If it truncates, the fix is the rail width
(260 → 268px), not the type size. Wait for confirmation.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-frontend/src/components/AppShell
git commit -m "fix(sidebar): raise nav and workspace rows to 14px

The rail was 13px with -0.25px tracking in a 260px sidebar, which read as both
small and cramped. Rows go to text-ui-md with 34px height so the 20px
line-height has room; section labels move to the eyebrow step in subtle, and
the wordmark to strong."
```

---

### Task 9: Close the ratchets and document the roles

**Files:**
- Modify: `scripts/design-tokens.test.js`
- Modify: `packages/design-tokens/tokens.css`

**Interfaces:**
- Consumes: `PENDING_INACTIVE`, `PENDING_SIZES`.
- Produces: nothing.

- [ ] **Step 1: Assert the ratchets are closed**

Append:

```js
// The remediation is finished when the sizing allowlist is empty and the inactive allowlist holds
// only genuine disabled-state call sites. These bounds stop either list being quietly grown.
test('the sizing allowlist is empty', () => {
  assert.deepEqual([...PENDING_SIZES], [])
})

test('the inactive allowlist holds only disabled-state call sites', () => {
  for (const rel of PENDING_INACTIVE) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    assert.match(
      text,
      /disabled|aria-disabled/,
      `${rel} uses text-kumo-inactive but has no disabled control — move it to subtle`,
    )
  }
})
```

- [ ] **Step 2: Add the role header to the token file**

At the top of the TEXT block in `tokens.css`, above the rungs:

```css
  /* Roles, so nobody has to guess again:
       strong      headings, page and card titles, the wordmark
       default     body copy, nav labels, row titles
       subtle      captions, metadata, timestamps, uppercase eyebrows, empty-state prose
       placeholder input placeholders — and only on `base` or a transparent parent, never `tint`
       inactive    disabled controls, and nothing else. It is 2.48:1 by design.
     Enforced by scripts/design-tokens.test.js, not by convention. */
```

- [ ] **Step 3: Full verification**

```bash
pnpm test && pnpm lint && pnpm build
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/design-tokens.test.js packages/design-tokens/tokens.css
git commit -m "test(tokens): close the remediation ratchets

The sizing allowlist is empty and the inactive allowlist is asserted to hold
only call sites with a real disabled control. Records each rung's role in the
token file so the next reader does not have to infer it from usage — which is
how #a9b6cb ended up carrying content 212 times."
```

---

## Not in this plan

Carried forward deliberately, per the spec's out-of-scope table:

- **Tailwind `--spacing` base** — still reflows layout; unchanged since 2026-08-06.
- **Radius and elevation** — settled by that spec's A3 and elevation mapping.
- **The dark ramp** — already passes at 15.52 / 7.34 / 4.58.
- **Gatekeeper UI typeface** — `gatekeeper-context` and `gatekeeper-scheduler` build to
  self-contained single-file bundles and cannot reach the Workshop's `public/`, so they keep the
  system stack. Known, bounded divergence; they do import the shared tokens, so all colour fixes
  reach them.
- **Third-party vendor brand colours** — correct as-is.
