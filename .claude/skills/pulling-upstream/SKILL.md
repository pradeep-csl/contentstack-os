---
name: pulling-upstream
description: Use when taking changes from the upstream cloudflare/cloudflare-os repository into this fork — pulling, syncing, or merging parent-repo main into the merge branch — or when a previous upstream pull left conflicts, failing fork guards, or reverted fork work.
---

# Pulling upstream into the fork

This fork carries deliberate, load-bearing changes on top of `cloudflare/cloudflare-os`. Taking a pull means integrating upstream's work **without the fork losing anything by accident**.

The fork may lose something *deliberately* — when upstream ships a feature that genuinely needs the code the fork changed. Never silently.

## The thing that actually goes wrong

**Conflicts are the safe case.** Git stops and asks.

The dangerous case is a file upstream changed and the fork did not. It auto-merges cleanly, silently reverts fork intent, and nothing fails. In the 2026-08-20 pull there were four of those and **not one produced a conflict**: the product name reverted to "Cloudflare OS", both design ratchets silently stopped being run, the Context Library's workerd suite was orphaned, and a live prop lost its only use.

So: a clean merge is not evidence of a safe merge. It is where fork work dies.

## Order of operations

Do these in order. The order is the point.

| # | Phase | Must not skip because |
|---|---|---|
| 1 | Tag `pre-upstream-merge` and `upstream-merge-target` | `merge` is shared history; a bad pull can't be thrown away by deleting a branch. Also gives you the "before" side of every diff. |
| 2 | **Run the guards BEFORE merging** — `node --test 'scripts/**/*.test.ts'` | Green here is what makes later red attributable to the merge. Run it after and you cannot tell merge damage from pre-existing red. |
| 3 | Survey: risk set, upstream deletes, upstream renames | A file upstream deleted that the fork edited needs its edits *ported*, not dropped. |
| 4 | Merge with `--no-commit --no-ff`, resolve by triage (below) | |
| 5 | Verify: install, lint, types, build, guards, tests | |
| 6 | Hunt silent reverts the guards don't know about (below) | The guards defend only intents someone thought to assert. |
| 7 | Report. **Stop.** | Pushing and promoting are the human's, not yours. |

Exact command blocks: `docs/upstream-merge-runbook.md`. What the fork protects: `docs/fork-delta.md` — that file is the authority, not this skill.

## Triage: every conflict is one of three

| Case | Shape | Do |
|---|---|---|
| **Independent** | The two changes don't interact | Keep both. Most of any pull. |
| **Reconcilable** | Upstream's change touches code the fork changed, but both intents can coexist | **Accommodate both.** This is the common case and it is more work than picking a side — which is exactly why it gets skipped. |
| **Incompatible** | Upstream's feature cannot land while fork intent stands | Upstream wins, via the cede protocol. Never silently. |

Reconcilable looks like: upstream adds responsive `sm:`/`md:` variants to a class the fork moved onto `text-ui-*` → keep the breakpoints, express the sizes on the fork's scale. Or upstream renames a field in the method where the fork added a latch → keep the latch, on the new name.

When upstream's new code violates a fork ratchet (a bare `text-xs`, an export without JSDoc, a banned hex), **migrating upstream's code is the resolution** — not an exception, not an allowlist entry.

## Cede protocol

Ceding is three things in **one commit**, so the trade lands in the pull request diff:

1. Move the row in `docs/fork-delta.md` from **Held** to **Ceded**, with the reason and the upstream commit.
2. Delete its assertion from `scripts/fork-intent.test.ts`. Retire the id; never reuse it.
3. Record what the fork loses, and what covers it now (or "none", with why).

A deleted assertion without its ledger row is the thing to catch in review.

## Hunting silent reverts

Three techniques. Each found something real that no conflict marked.

1. **Read every config upstream changed that the fork didn't.** Root `package.json`, `tsconfig.json`, `pnpm-workspace.yaml`, lint config, per-package `vite.config.ts` / `vitest*.config.ts`, CI workflows. These auto-merge and change *what runs*.
2. **Compare fork-marker counts per file, before and after.** Explain every difference. Count per file — do not grep for the shape you expect. A scan for `= "..."` literals missed three doc comments carrying the product name.
3. **Believe the compiler and the ratchets.** An unused variable or unreferenced export usually means a fork *usage* was dropped while its declaration survived.

## Stop and ask

Never do these unprompted: push any branch, open/close/merge a pull request, promote to `develop` or `main`, or start a pull that wasn't asked for. The human owns branch currency, the soak on `merge`, and promotion.

## Environment and known noise

| Symptom | Reality |
|---|---|
| `node: command not found` | Not on the default PATH. `export PATH="/opt/homebrew/bin:$HOME/Library/pnpm:$PATH"` |
| `pnpm install` aborts on TTY | Needs `CI=true` to purge `node_modules` non-interactively. |
| Manifests changed | `pnpm install --lockfile-only` then `--frozen-lockfile`. **Never hand-merge `pnpm-lock.yaml`** — take upstream's and regenerate. |
| Test task exits **137** | SIGKILL, not failure — concurrent workerd pools exhausting memory. Re-run that package alone before believing it. |
| `useAuth` / `homePromptFlow` fail locally | Node 26 gates native `localStorage` behind `--localstorage-file`. They fail identically on pristine upstream; CI pins Node 24. Verify with a worktree, don't debug. |
| A vitest config seems unused | `vp` runs the `test` task in `vite.config.ts`, **not** the `package.json` script. A config named only in a script never runs. |
| Huge conflict count in `api.ts` / `ChatInterface.tsx` | Mostly the fork's prettier-style reflow, not behaviour. Rebuild on upstream's copy and re-apply fork additions rather than hand-merging hunks. |

## Rationalizations

Observed, not hypothetical — every one of these was available during the 2026-08-20 pull.

| Excuse | Reality |
|---|---|
| "It auto-merged, so it's fine" | All four silent reverts auto-merged with zero conflicts. |
| "Taking theirs is simpler" | That is precisely how `DEFAULT_SITE_NAME` reverted. Simpler for you, invisible to everyone else. |
| "The tests pass" | The tests were not running. The root glob had moved and both design ratchets were being skipped. |
| "It's only a comment" | Three doc comments carried the product name. |
| "I'll run the guards at the end" | Then you cannot attribute red to the merge. Baseline first. |
| "Upstream's version is newer, so it's better" | Newer for upstream. Fork intent does not become stale because upstream moved. |
| "The guard is green, so nothing was lost" | The guard covers only asserted intents. Phase 6 exists for the rest. |

## Red flags — stop

- Resolving a conflict by picking a side without asking whether both fit
- Deleting an assertion from `fork-intent.test.ts` with no Ceded row in the same commit
- Running the fork guards for the first time *after* merging
- Adding a file to a ratchet's PENDING allowlist to make upstream's code pass
- Pushing, touching a PR, or promoting without being asked
