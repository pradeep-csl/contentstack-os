# Type and contrast remediation — finishing the Venus re-skin

**Date:** 2026-08-19
**Status:** Design approved, pending spec review
**Supersedes nothing.** This completes deferred items from
`2026-08-06-contentstack-design-system-design.md`; that spec's decisions stay in force
except where noted below.

## Problem

The Venus re-skin made the product Contentstack-purple, but the UI reads faded and its text
reads small. Measurement confirms the complaint is structural, not a matter of taste.

**The neutral text ramp fails in light mode.** Against `#ffffff` / `#f7f9fc` / `#edf1f7`:

| Token | Value | on base | on elevated | on tint |
|---|---|---|---|---|
| `default` | `#475161` | 8.02 | 7.61 | 7.08 |
| `subtle` | `#647696` | 4.59 | 4.35 | **4.05** |
| `inactive` | `#a9b6cb` | **2.05** | **1.94** | **1.81** |

`subtle` clears AA on white by 0.09 and **fails on `tint`** — which is the hover surface, so
contrast degrades exactly when a user is reading a row. `inactive` fails everywhere.

**Light mode is roughly one rung paler than dark mode at every step.** Dark was calibrated when
the palette was chosen; light inherited Venus values unmeasured:

| Token | Light, on base | Dark, on base |
|---|---|---|
| `default` | 8.02 | 15.52 |
| `subtle` | 4.59 | 7.34 |
| `inactive` | 2.05 | 4.58 |

**Both failures were predicted by the 2026-08-06 spec and deferred.** It said of `#a9b6cb`:
*"It becomes a defect only if the token is used for placeholder text or timestamps rather than
disabled state — worth an audit during implementation, but out of scope to fix globally here."*
The audit never ran. `text-kumo-inactive` is used **212 times**; roughly ten concern disabled
state. The rest carry content: all 27 uppercase section labels (`FAVORITES`, `RECENT WORKSPACES`,
`GET STARTED`), all 19 input placeholders, file names, timestamps, captions, and empty-state
prose. The same spec also said body copy must not sit in `subtle` on `tint`; that never ran either.

**`inactive` is a misreading of Kumo's vocabulary, not just a bad value.** Kumo's own light-mode
`--text-color-kumo-inactive` is `oklch(87% 0 0)` — paler still. In Kumo, `inactive` means
*disabled*, deliberately near-invisible. Our content uses were never what the token is for.

**The hierarchy is inverted.** `text-kumo-strong` appears 40 times; `subtle` and `inactive`
together appear 643. The largest text in the product — the Home `h1` at 30px — is set to
`text-kumo-default`, a body grey, as are the sidebar wordmark and every card title. Nothing on
the page sits at heading contrast, so nothing anchors the eye.

**Six Kumo semantic text tokens are never declared**, so they fall back to Kumo's unbranded
defaults. We define 11 of 16.

| Undeclared token | Falls back to | Consequence |
|---|---|---|
| `--text-color-kumo-placeholder` | `oklch(70.8% 0 0)` | ≈2.1:1 hueless grey in every Kumo input |
| `--text-color-kumo-info` | `oklch(42.4% 0.199 265.6)` | generic blue, not Venus `#0469e3` |
| `--text-color-kumo-badge-orange-subtle` | `oklch(47% .157 37.3)` | **an orange** — see the amendment note on this figure |
| `-badge-teal-subtle` / `-badge-neutral-subtle` / `-badge-inverted` | Kumo neutrals | unbranded |

The 2026-08-06 verification step required confirming "no warm-orange survives." One did, in a
token we never declared.

**There is no type scale.** Roughly 490 hardcoded pixel sizes span thirteen distinct values
(9, 10, 11, 12, 13, 14, 15, 17, 18, 20, 28, 30, 34) alongside Tailwind's named scale
(`text-sm` 133×, `text-xs` 65×). `styles.css` also restores Tailwind's defaults over Kumo's, so
three scales coexist. Raising nav text is a 163-literal search, not a token edit. The 2026-08-06
spec excluded the scale by decision D3 ("reflows layout across ~45k LOC").

**The typeface never loads.** `--font-sans` names `"FT Kunst Grotesk"` with no `@font-face`, no
font file, and no dependency anywhere in the repo. It entered in `5c58306` ("Update frontend to
use Tanstack and Kumo") — it is Cloudflare's brand font, inherited from the fork and never
licensed. Every user renders in `-apple-system` or Segoe UI. Excluded by decision D8.

Two consequences compound the "small and cramped" complaint. `tracking-[-0.25px]` is applied to
13px text in 163 places; SF Pro and Segoe UI already tighten optically below 14px, so the
adjustment double-counts. And `body { @apply antialiased }` sets
`-webkit-font-smoothing: antialiased`, which on macOS disables subpixel rendering and thins every
glyph — a contrast loss on top of a ramp that is already too pale.

## Decisions

| # | Decision |
|---|---|
| T1 | When Venus conflicts with readability, **readability wins**; each deviation is documented in `tokens.css` beside the three that already exist. Supersedes the 2026-08-06 stance of treating Venus's `variables.css` as authority for the neutral ramp. |
| T2 | **Collapse the ramp to three content rungs** — `strong` / `default` / `subtle` — plus `inactive` reserved for disabled state. There is no room on white for four passing greys; measurement puts the ceiling at three. |
| T3 | Kumo token **names cannot change** — Kumo's compiled CSS consumes them. Only values change, and the six undeclared tokens get declared. No parallel `--text-role-*` vocabulary; per `CLAUDE.md`, reuse the existing mechanism. |
| T4 | **Ship Inter Variable, self-hosted.** Delete the `"FT Kunst Grotesk"` reference. Reverses D8. |
| T5 | **Adopt a named 8-step `text-ui-*` scale** and migrate all ~730 sizing call sites onto it — the pixel literals *and* the Tailwind-named uses. Tailwind's own `--text-*` definitions stay untouched for Kumo's benefit. Reverses D3. |
| T6 | **Negative tracking only above 18px.** Zero at UI sizes. |
| T7 | **Remove `antialiased` from `body`.** |
| T8 | Brand-as-*text* lightens for contrast; `--color-kumo-brand` **fills stay `#6c5ce7`**. Extends D5's light/dark split to light mode. |
| T9 | Dark mode's ramp is **unchanged**. It already measures 15.5 / 7.3 / 4.6 and needs no work. |
| T10 | Surface and hairline changes land as **their own revertable commit**, being the widest blast radius here. |

## Token changes

All values verified against `#ffffff`, the proposed `elevated`, and the proposed `tint`.

### Content ramp — light

| Token | From | To | base / elev / tint |
|---|---|---|---|
| `--text-color-kumo-strong` | `#222222` | `#1c2333` | 15.70 / 14.61 / 13.48 |
| `--text-color-kumo-default` | `#475161` | `#3d4658` | 9.48 / 8.82 / 8.14 |
| `--text-color-kumo-subtle` | `#647696` | `#5b6580` | 5.80 / 5.40 / 4.98 |
| `--text-color-kumo-inactive` | `#a9b6cb` | `#9aa5ba` | 2.48 / 2.31 / 2.13 — disabled only |

`#1c2333` rather than a flat `#222222` keeps headings in the ramp's blue-grey hue family instead
of reading as a separate black. `inactive` stays deliberately below AA: WCAG exempts genuinely
disabled controls, and a disabled control that reads as enabled is its own defect.

### Newly declared tokens

| Token | Value | Note |
|---|---|---|
| `--text-color-kumo-placeholder` | `#66708a` | 4.94 on base, 4.60 on elevated |
| `--text-color-kumo-info` | `#0057c2` | 6.68 on base |
| `--text-color-kumo-badge-orange-subtle` | `#704b00` | Venus attention-dark |
| `--text-color-kumo-badge-teal-subtle` | `#1f6f78` | Venus media hue, darkened to pass |
| `--text-color-kumo-badge-neutral-subtle` | `#5b6580` | tracks `subtle` |
| `--text-color-kumo-badge-inverted` | `#ffffff` | tracks `inverse` |

Placeholders are measured to sit only on `base` (12 uses) or `transparent` (7) — never on `tint`
— so 4.94/4.60 is a genuine pass for the surfaces they occupy. That constraint is recorded as a
doc comment, mirroring how the existing spec constrains `subtle`.

### Brand and status text — light

| Token | From | To | on base |
|---|---|---|---|
| `--text-color-kumo-link` / `-brand` | `#6c5ce7` | `#5b48d9` | 4.86 → 6.22 |
| `--text-color-kumo-danger` | `#d62400` | `#c92000` | 5.11 → 5.69 |
| `--text-color-kumo-success` | `#007a52` | `#006946` | 5.38 → 6.75 |

`--text-color-kumo-warning` stays `#704b00` (7.79). Every `--color-kumo-*` **fill** is unchanged.

### Surfaces and hairline — light, separate commit

Base-to-elevated is currently 1.055:1 and the hairline 1.20:1, so panel edges and card borders
barely register — a flatness that reads as washed-out independently of text colour.

| Token | From | To |
|---|---|---|
| `--color-kumo-elevated` | `#f7f9fc` | `#f4f7fb` |
| `--color-kumo-tint` / `--color-kumo-fill` | `#edf1f7` | `#e9eef6` |
| `--color-kumo-line` | `#4751611f` (12%) | `#47516133` (20%) — 1.20 → 1.36:1 |

`--color-background-200` / `-300` track `elevated` / `tint`. Darkening `tint` slightly lowers
text-on-tint contrast; the ramp above is measured against the new value, and everything still
passes.

## Typography

### Typeface

Inter Variable, self-hosted at `packages/workshop-frontend/public/fonts/`, SIL Open Font License.
`@font-face` with `font-display: swap`, `font-weight: 100 900`, and a `size-adjust` guard tuned
against the system fallback to keep swap from shifting layout. `--font-sans` becomes
`"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", sans-serif`.
`--font-mono` keeps its system stack; `"Apercu Mono Pro"` is dropped for the same reason as
Kunst Grotesk.

The font is shipped by `workshop-frontend`. The two gatekeeper UIs (`gatekeeper-context`,
`gatekeeper-scheduler`) build to self-contained single-file bundles and cannot reach the
Workshop's `public/`, so they keep the system stack for now; their type is small in volume and
this is recorded as known, bounded divergence rather than silently ignored.

### Scale

Defined in `@theme` in `styles.css` under a dedicated `text-ui-*` namespace.

**Why a new namespace rather than redefining `text-xs` / `text-sm` / `text-base`.** Those names
are already load-bearing twice over. `styles.css` deliberately redefines them to restore
Tailwind's defaults over Kumo's, and Kumo's own components are compiled through the `@source`
scan against them — so `text-sm` currently means 14/20 to both our 133 call sites *and* to every
Kumo component. Re-pointing it at 13/18 would silently shrink all of them. Keeping Tailwind's
names at their present values for Kumo's benefit, and moving app code onto one explicit scale,
is the only option that leaves a single vocabulary in our own code without disturbing the library.

| Token | Size / line-height | Tracking | Use |
|---|---|---|---|
| `text-ui-2xs` | 11 / 16 | `+0.06em`, 600 | uppercase eyebrows and badges only |
| `text-ui-xs` | 12 / 16 | `0` | captions, metadata, timestamps |
| `text-ui-sm` | 13 / 18 | `0` | dense UI — chips, table cells |
| `text-ui-md` | 14 / 20 | `0` | default body and nav |
| `text-ui-lg` | 15 / 22 | `0` | prose, chat messages |
| `text-ui-xl` | 18 / 26 | `-0.01em` | card and section titles |
| `text-ui-2xl` | 22 / 28 | `-0.015em` | subsection headings |
| `text-ui-3xl` | 30 / 36 | `-0.02em` | page headings |

9, 10, 17, 20 and 30px disappear from app code. The `--text-xs` / `-sm` / `-base` / `-lg`
definitions stay exactly as they are, serving Kumo only; the recurrence lint rule (below) bans
them in our own `.tsx`.

Inter's x-height is larger than SF Pro's at equal pixel size, so small labels gain weight from
the typeface change before any size change applies.

### Migration mapping

Both vocabularies migrate, not just the pixel literals — **roughly 730 call sites**, not the ~490
literals alone. This is the largest diff in the plan and the reason step 7 is isolated.

From pixel literals:

| From | To |
|---|---|
| `text-[9px]`, `text-[10px]`, `text-[11px]` | `text-ui-2xs` |
| `text-[12px]` | `text-ui-xs` |
| `text-[13px]` | `text-ui-sm`, or `text-ui-md` where the element is nav or body |
| `text-[14px]` | `text-ui-md` |
| `text-[15px]` | `text-ui-lg` |
| `text-[17px]`, `text-[18px]` | `text-ui-xl` |
| `text-[20px]` | `text-ui-xl` or `text-ui-2xl`, per element |
| `text-[22px]` | `text-ui-2xl` |
| `text-[28px]`, `text-[30px]`, `text-[34px]` | `text-ui-3xl` |

From Tailwind's names, at the values they resolve to *today*:

| From | Resolves to today | To |
|---|---|---|
| `text-xs` (65) | 12 / 16 | `text-ui-xs` |
| `text-sm` (133) | 14 / 20 | `text-ui-md` |
| `text-base` (5) | 16 / 24 | `text-ui-lg`, per element — this one shrinks 1px |
| `text-lg` (21) | 18 / 28 | `text-ui-xl` |
| `text-xl` (3), `text-2xl` (8), `text-3xl` (3) | 20 / 24 / 30 | per element |

Rows marked "per element" are not mechanical and get reviewed individually. Every
`tracking-[-0.25px]` / `-0.2px` / `-0.1px` below 18px is removed rather than translated.

## Usage migration

1. **`inactive` → `subtle`** for all ~200 content uses. Keep `inactive` only where the *class* is
   scoped to the disabled state (`disabled:text-kumo-inactive`) — **not** merely where the element
   happens to carry a `disabled` prop. See the amendment note: the weaker test stated in earlier
   drafts let nine enabled controls ship at 2.48:1.
2. **Placeholders** — replace `placeholder:text-kumo-inactive` (19 uses) with the declared
   `placeholder` token, so ours and Kumo's own inputs finally match.
3. **Restore hierarchy** — Home `h1`, sidebar wordmark, card and row titles, dialog titles and
   section headings move to `text-kumo-strong`.
4. **`subtle` off `tint`** — where body copy sits in `subtle` on a tinted surface, it moves to
   `default`, discharging the 2026-08-06 instruction.
5. **Sidebar** — nav rows and workspace rows to `text-ui-md`, row height 32px → 34px so the 20px
   line-height does not crowd. Section labels to `text-ui-2xs` in `subtle` at weight 600.

## Preventing recurrence

`scripts/legacy-palette.test.js` already establishes the repo's mechanism for this: a **ratchet
guard**, where offending files sit in a `PENDING` allowlist and a second test fails if an entry no
longer needs to be there — so the list can only shrink. It is currently down to one entry (its own
LEGACY array), meaning the Cloudflare-palette migration ran to completion under it. Per
`CLAUDE.md`'s preference for reusing existing mechanisms, the guards here follow that pattern
rather than introducing custom lint rules.

`scripts/design-tokens.test.js` (new), run by the root `node --test scripts/*.test.js`:

1. **Contrast** — parse the light `@theme` block, compute WCAG ratios for every content token
   against `base`, `elevated` and `tint`, and assert ≥4.5. Computed, not allowlisted, so it can
   never drift. `inactive` is asserted to be *below* AA, since a disabled control that reads as
   enabled is its own defect.
2. **Completeness** — scan Kumo's compiled `dist/` for every `--text-color-kumo-*` it consumes and
   assert each is declared in `tokens.css`. This is the test that would have caught the orange.
3. **`inactive` misuse** — ratchet guard: no `text-kumo-inactive` in `.tsx` outside `PENDING`,
   which starts at the current ~200 files and shrinks to the genuine disabled-state call sites.
4. **Type scale** — ratchet guard: no `text-[Npx]`, no bare Tailwind `text-xs`/`-sm`/`-base`/`-lg`
   in our `.tsx`, and no negative `tracking-[…]` paired with a sub-18px step.

Plus a **role doc-comment per token** in `tokens.css` stating what each rung is for and, for
`inactive` and `placeholder`, what they must not be used for; and a note beside the surviving
`--text-*` block explaining it exists for Kumo only, so nobody "tidies" it away and shrinks every
Kumo component.

The legacy font families join `LEGACY` in `scripts/legacy-palette.test.js`, so
`"FT Kunst Grotesk"` and `"Apercu Mono Pro"` cannot return.

## Out of scope

| Excluded | Reason |
|---|---|
| Tailwind `--spacing` base | Unchanged from 2026-08-06. Still reflows layout. |
| Radius and elevation | Settled by A3 and the elevation mapping; nothing here disputes them. |
| Component restructuring | Class-string edits only, as with the original re-skin. |
| Dark-mode ramp | T9 — already passes. |
| Gatekeeper UI typeface | Cannot reach the Workshop's `public/`; noted divergence. |
| Third-party vendor brand colours | Correct as-is, per 2026-08-06. |

## Verification

The earlier draft of this spec asserted these changes are "not unit-testable." That is only half
right, and the weaker half. **Token values and token usage are both testable** — see the guards
above — and gating them mechanically is what stops this recurring a third time. What genuinely
needs a human is reflow and aesthetic judgement.

Mechanical:

1. `node --test scripts/design-tokens.test.js` — the four guards. Each is written *before* the
   change it guards, and must be observed failing first.
2. `pnpm lint` (oxlint + recursive `tsc --noEmit`) and `pnpm test`.
3. Build all three surfaces; confirm the shared-token import still resolves under
   `@tailwindcss/vite` and the Inter `@font-face` resolves in the built asset output.

Human, live — the author has frontend and backend running, so each step is reviewed in the running
app rather than from screenshots:

4. After each step, in **both** modes: home, chat, workspace editor, blueprints, outputs,
   connectors, admin, login. Reflow from the type scale is the main risk — watch truncation,
   wrapped buttons, clipped table cells.
5. Confirm no disabled control now reads as enabled.
6. Confirm the admin accent override still works and that clearing it restores `#6c5ce7`.

## Sequencing

Each step is independently visible and revertable. Steps 1–3 are the whole "faded" complaint and
land before any layout risk is introduced.

1. **Declare the six missing Kumo tokens.** Kills the orange leak and the hueless placeholders.
   No existing value changes.
2. **Retune the light ramp** — content rungs, brand and status text.
3. **Migrate usage** — `inactive` → `subtle`, placeholders, restored hierarchy, `subtle` off
   `tint`.
4. **Surfaces and hairline** (T10) — separate so it can be reverted alone.
5. **Ship Inter**, remove the phantom families, drop `antialiased`.
6. **Add the type scale** to `@theme` without migrating anything — no visual change yet.
7. **Migrate onto the scale** — pixel literals and Tailwind-named uses both — and strip sub-18px
   negative tracking. The reflow step: ~730 call sites, largest diff, review most closely. Worth
   splitting per route directory if it gets unwieldy.
8. **Sidebar sizing** — `text-ui-md`, 34px rows, section labels.
9. **Close the ratchets** — shrink each guard's `PENDING` to its true residue and add the role
   doc-comments.

Steps 1–4 touch `packages/design-tokens` plus frontend class strings. Steps 5–8 touch
`workshop-frontend` only. `workshop-shared` and `workshop-backend` are untouched, so no
kernel-bar review applies.


## Amendments made during execution

This design was amended **39 times** while being implemented. The rulings are recorded in
`.superpowers/sdd/2026-08-19-type-and-contrast-remediation/progress.md`, each with its rationale and
what it costs if wrong. The ones that change how this document should be read:

| # | Amendment |
|---|---|
| R10 | The `inactive` exemption test above was **wrong as originally written**. What matters is whether the *class* is `disabled:`-scoped, not whether the element carries a `disabled` prop. Under the weaker test, nine enabled controls — including the permission prompt's "Deny" and "Always approve" — shipped at 2.48:1. |
| R11 | The per-file `PENDING_INACTIVE` allowlist this spec proposed was replaced by a semantic guard permitting `text-kumo-inactive` only when `disabled:`-scoped. The allowlist would have exempted all 7,500 lines of `ChatInterface.tsx` — the largest source of the original misuse. |
| R17 | The type-scale migration was 4 dispatches, not 1. Measured scope was 727 sizing sites **plus 432 judgement calls**, of which 187 line-height/letter-spacing collisions were described here as a footnote. |
| R19/R22 | This spec's letter-spacing list named 3 px values; the tree had 8 (46 sites missed). Its size census said 489 pixel literals; the real figure was 510 — a `\d+` regex silently excluded `text-[11.5px]` and `text-[12.5px]`. |
| R25/R34 | `tracking-tight`/`tighter` are negative letter-spacing exactly as `tracking-[-0.35px]` is, and are now banned outright. The same source-order collision applies to `font-*` on `text-ui-2xs`, which was defeating that step's built-in weight 600 at 37 of 98 sites. |
| R28 | `rgba(255, 72, 1, …)` is `#ff4801` — the **old Cloudflare brand orange** — and survived in five places, invisible to the legacy-palette guard because it knew the hex plus a *different* orange's `rgb()` spellings. The 2026-08-06 verification step "confirm no warm-orange survives" had failed twice. |
| R30 | `text-ui-3xl` is **30/36, not 28/34**. The mapping table below collapses 28/30/34px into one step; those 12 `h1` sites were previously Tailwind's `text-3xl` = 30px, which this repo does not override, so every page heading would have silently shrunk 2px. |
| R32 | The completeness guard checked only `--text-color-kumo-*`, missing **28 `--color-kumo-*` tokens**. One of them, `--color-kumo-hairline`, was falling back to a hueless 1.21:1 grey that Kumo uses for every dropdown separator and component ring — so the surface-separation work never reached any Kumo-drawn edge. |
| R33 | The heading-hierarchy migration shipped at ~15% (1 of 12 page `h1`s) because colour migration ran *before* the type scale existed, so no task ever held the heading sites and the hierarchy decision in one frame. All 23 sites are now `strong`, with a guard pinning it. |
| R36/R37 | The out-of-scope table excludes the gatekeeper UIs' **typeface** only. It never sanctioned leaving them 31 content uses at 2.48:1, nor leaving `mcp-shared/src/html.ts` on the pre-retune palette its own comment claims to mirror. Both were fixed; their remaining size debt is ratcheted, not hidden. |

Two figures in this document did not survive verification and should not be reused:

- **"57 badge uses"** for `--text-color-kumo-badge-orange-subtle`. The token has 5 references in
  Kumo's `dist/` and the app renders no orange or teal `Badge`. Declaring it was still correct, and
  the real surviving orange was R28's `#ff4801` — but the 57 figure is wrong.
- **"not unit-testable."** The Testing section originally asserted these changes could not be
  verified mechanically. A 226-line suite at `packages/workshop-frontend/src/designTokens.test.ts`
  already proved otherwise, and duplicating its WCAG maths in `scripts/` is how a surface change
  broke one suite while the other stayed green for three tasks (ruling R23, consolidated in Task 9).

**Deferred, recorded, not done:** 64 `leading-*` overrides that genuinely differ from their step —
12 of them (`text-ui-lg leading-5`) suggest `--text-ui-lg--line-height` may want 20px rather than
the 22px specified here, since half that step's call sites ask for it. Plus ~120 ad-hoc sizes in the
two gatekeeper UIs, behind a seeded ratchet.
