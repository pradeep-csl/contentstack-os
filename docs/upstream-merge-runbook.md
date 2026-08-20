# Pulling upstream into the fork

How to take a `cloudflare/cloudflare-os` pull into `merge` without losing fork work, and how to know you didn't.

**Scope.** This covers resolving the pull and proving no regression. Keeping `merge` current before the pull, and promoting `merge → develop → main` after the soak, are handled outside this document.

## The rule

Fork work is never overwritten *by accident*. It may be overwritten *deliberately*, when upstream ships a feature that genuinely needs the code the fork changed. Every conflict, and every silently-changed fork behaviour, falls into one of three cases:

**1. Independent** — the two changes don't interact. Keep both. Most of any pull.

**2. Entangled but reconcilable** — upstream's change touches code the fork changed, and both intents can coexist. Accommodate both. This is the common conflict and it is usually more work than picking a side, which is exactly why it gets skipped. Examples from 2026-08-20:

- Upstream added `HTTPS_ONLY_PROVIDERS` to the class the fork had renamed to `CloudflareModelGateway`. Kept the rename *and* the constant — then renamed the references in upstream's new tests, which still said `AiGatewayConfig`.
- Upstream renamed `this.owner` to `this.#owner` in the method where the fork latches `titleChosenByUser`. Kept the latch, on the private field.
- Upstream extracted `ReconnectingChip` out of `GadgetEditor`. Took the extraction, and carried the fork's `text-ui-xs` into the new component.

**3. Genuinely incompatible** — upstream's feature cannot land while fork intent stands. Upstream wins, via the cede protocol below. Never silently.

## Cede protocol

Ceding is three things in **one commit**, so the trade appears in the pull request diff:

1. Move the row in `docs/fork-delta.md` from **Held** to **Ceded**, with the reason and the upstream commit.
2. Delete its assertion from `scripts/fork-intent.test.ts`. Retire the id; never reuse it.
3. Record the regression risk in the Ceded row — what the fork loses, and what covers it now (or "none", with why).

Deleting the assertion on its own is the thing to watch for in review. It is a one-line diff that gives up fork behaviour, and it should never appear without its ledger row.

## Steps

### 1. Tag the pre-merge state

```sh
git tag -f pre-upstream-merge HEAD
git fetch upstream && git tag -f upstream-merge-target upstream/main
```

`merge` is long-lived shared history, so a bad pull can't be discarded by deleting the branch. These two tags are what let you diff three ways, and what `git reset --hard pre-upstream-merge` needs if you abandon the attempt.

### 2. Baseline the guards — before merging

```sh
node --test 'scripts/**/*.test.ts'
```

Green here means later red is the merge's doing. Skipping this step forfeits the ability to tell those apart.

### 3. Survey before resolving

```sh
MB=$(git merge-base HEAD upstream/main)
# What both sides touched: the risk set.
comm -12 <(git diff --name-only $MB HEAD | sort) <(git diff --name-only $MB upstream/main | sort)
# Files the fork edited that upstream deleted -- these become modify/delete conflicts, and their
# fork edits have to be ported to whatever replaced them.
comm -12 <(git diff --name-only $MB HEAD | sort) \
         <(git diff --diff-filter=D --name-only $MB upstream/main | sort)
# Renames, so a "deleted" file can be recognised as a move.
git diff -M --name-status --diff-filter=R $MB upstream/main
```

### 4. Merge and resolve

```sh
git merge --no-commit --no-ff upstream/main
```

Resolve by the triage rule. Two habits worth keeping:

- **When a file is mostly restyled, rebuild on upstream's copy and re-apply fork additions** rather than hand-merging. `api.ts` had 49 conflict hunks in 2026-08-20 because upstream restyled the whole module to doc comments; almost none were about behaviour. Enumerate the fork's real additions (`git show <tag>:<file>`, diff the exported-name sets), take upstream's file, re-apply. Fewer chances to be wrong.
- **After resolving, check the whole tree for stale references to what you kept.** A fork rename kept on one side leaves upstream's new callers pointing at the old name — they compile as errors if you're lucky and pass as dead code if you're not.

### 5. Verify

```sh
pnpm install --lockfile-only && pnpm install --frozen-lockfile   # the dependency graph moves a lot
pnpm lint:check && pnpm types:scripts && pnpm build
node --test 'scripts/**/*.test.ts'                               # includes both fork guards
pnpm test
```

Never hand-merge `pnpm-lock.yaml`. Take upstream's and regenerate.

Any red in `fork-intent.test.ts` names the intent by id and in plain language: reconcile it (case 2) or cede it (case 3).

### 6. Look for silent reverts the guard doesn't know about

The guard defends *known* intents. A pull can revert something nobody thought to assert, and the only defence is looking. Three techniques, each of which found something real in 2026-08-20:

**Read every config upstream changed that the fork didn't.** These auto-merge with no conflict and change what runs. The root `package.json` test glob, `tsconfig.json`, `pnpm-workspace.yaml`, the lint config, per-package `vite.config.ts` and `vitest*.config.ts`, CI workflows.

```sh
git diff $MB upstream/main -- package.json tsconfig.json pnpm-workspace.yaml '**/vite*.config.ts'
```

**Compare fork-marker counts per file, before and after.** Explain every difference; each one is either intended or a revert.

```sh
for marker in "Contentstack" "text-ui-" "openrouter"; do
  git grep -l -- "$marker" pre-upstream-merge | sed 's|^pre-upstream-merge:||' | while read -r f; do
    o=$(git show "pre-upstream-merge:$f" | grep -c -- "$marker")
    m=$([ -e "$f" ] && grep -c -- "$marker" "$f" || echo GONE)
    if [ "$o" != "$m" ]; then printf '%-64s %s -> %s  (%s)\n' "$f" "$o" "$m" "$marker"; fi
  done
done
```

This is what caught `DEFAULT_SITE_NAME` reverting to "Cloudflare OS" — and note that a first pass scanning only `= "..."` literals missed the three doc comments that said it too. Count per file; don't grep for shapes you expect.

**Believe the compiler and the ratchets.** An unused variable or an unreferenced export often means a fork usage was dropped while its declaration survived — that is how `ChatInterface`'s dead `surface` prop surfaced. When a fork ratchet rejects upstream's new code, migrating it is the resolution, not an exception.

### 7. Soak, then hand off

Run the app on `merge` and exercise the fork's own surfaces specifically — the model pickers and gateway tags, workspace creation from the dialog, the chat rail, the Context Library UI and its ingestion endpoint, the theme in both light and dark. The guards prove the code still says what it meant; only running it proves it still works.

## Known noise

Things that look like breakage and aren't:

- **`useAuth.test.tsx` and `homePromptFlow.test.tsx` fail locally on Node 26**, which gates its native `localStorage` behind `--localstorage-file`. They fail identically on pristine `upstream/main`. CI pins Node 24.19.0, where they pass. Verify with a worktree before spending time on them: `git worktree add --detach /tmp/wt upstream/main`.
- **Exit code 137 from a test task** is SIGKILL, not a failure — concurrent workerd pools exhausting memory. Re-run that package's suite alone before believing it.
