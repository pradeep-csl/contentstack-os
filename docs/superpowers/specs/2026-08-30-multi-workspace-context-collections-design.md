# Multi-workspace scope for Context collections

Status: design, not yet implemented.

Direct successor to
[2026-08-21-workspace-context-visibility-design.md](./2026-08-21-workspace-context-visibility-design.md),
which introduced `workspace` visibility and deliberately left this open in §4.4: "`scopedToWorkspace?:
string` is single-valued. Widening it later to a set is a local change to the owner record and the
one filter that reads it — no new storage and no migration of existing records." This design cashes
that in. Section references below are to that document unless stated otherwise.

## 1. Problem

A Context collection scoped to a workspace is scoped to *exactly one*. The motivating case:

> I created a workspace `gtm1` and a Context collection of GTM knowledge, and scoped the collection
> to `gtm1`. Later I created `gtm2` for other GTM work, and I want that workspace's agent to read the
> same collection. Both workspaces should have it.

Today the only move is to *swap* the scope from `gtm1` to `gtm2`, taking it away from `gtm1`. The
alternatives are worse: duplicate the collection (two copies to maintain), return it to `private`
(which re-enables it in every workspace the owner has, not just the two they want), or publish it to
the whole deployment (admin-only, and far wider than intended).

## 2. Goals

1. A collection may be scoped to **several** workspaces at once; its agents read it in exactly those.
2. Workspaces can be added and removed after creation, independently, without disturbing the others.
3. Existing single-workspace collections keep working with no migration and no behavior change.
4. Removing one workspace revokes that workspace's access on the same terms as today's revoke, and
   leaves the remaining workspaces untouched.

## 3. Non-goals

- **No change to who may scope.** §4.2's rule stands: only the collection's owner, and in practice
  only to workspaces they own, because the host picker lists nothing else
  ([`GatekeeperWorkspacePicker.tsx`](../../../packages/workshop-frontend/src/GatekeeperWorkspacePicker.tsx):
  "Only workspaces the user owns are ever listed"). **Scoping into a workspace someone else owns
  remains impossible** and is not addressed here — see §10.
- **No cross-account grants.** Sharing a collection with another *user's* account is a separate,
  larger design; it needs an identity concept gatekeepers deliberately do not have. See §10.
- **No visibility transitions.** `private` ↔ `public` is still not possible after creation. Also
  deferred to §10.
- **No admin moderation.** §7.3 stands unchanged: an admin may write public collections and nothing
  else. Owner-only throughout.
- **Multi-select at create time.** The create dialog keeps its single-workspace pick. Adding more is
  a post-creation action, which is exactly the motivating flow and keeps the create diff at zero.
- **No change to exclusivity.** See §4.1 below.

## 4. Decisions taken, with rationale

### 4.1 Exclusivity is generalized, not abandoned

`visibility: "workspace"` continues to mean the collection is readable **only** through the listed
workspaces' agents — not through the owner's other workspaces. A set of workspaces is still a
*narrowing* of private, not private plus grants.

This preserves the reasoning in the predecessor's §4.1: the dialog presents Only me / Workspace /
Everyone as three mutually exclusive choices, and a user scoping project knowledge to a project would
be surprised to find it feeding every other workspace they own. Going from one workspace to N does
not change that argument; it only changes N.

The `visibility` field therefore stays a faithful projection of the scope set:

- set is empty → `visibility: "private"`
- set is non-empty → `visibility: "workspace"`

There is no fourth visibility and no new UI tier.

### 4.2 A set on the existing record, not a new index

The scope stays a field on the owner-library record. §4.3's conclusion still holds and for the same
reason: the facet reads only *its own account's* library, and the owner is the only possible granter,
so every scope relevant to a facet necessarily lives in that facet's account's library. Nothing else
needs to hold it.

Consequences preserved: no new Durable Object, no `wrangler.jsonc` change, no migration tag, no
release-manifest change, no dual-index writes.

### 4.3 Read-through normalization instead of a migration

Existing records carry `scopedToWorkspace?: string`. Rather than a deploy-time migration, every read
goes through a normalizer and every write emits the new field:

```ts
/**
 * The workspaces an owned record is scoped to. Records written before multi-workspace scope carry
 * the legacy single-valued `scopedToWorkspace`; they read as a one-element set and are rewritten in
 * the new shape the next time the record is touched.
 */
function recordScopes(record: OwnedRecord): string[] {
  if (record.scopedToWorkspaces) return record.scopedToWorkspaces;
  return record.scopedToWorkspace ? [record.scopedToWorkspace] : [];
}
```

`updateOwnedCollection` rebuilds the record from the summary on every metadata edit, so records
convert themselves as they are touched; nothing has to sweep them. `scopedToWorkspace` stays declared
as deprecated and is **never written again** — including on conversion, where it is explicitly
cleared, so a record can never carry two disagreeing scopes.

**The same normalization is required a second time, on the collection's own metadata, and missing it
is the sharpest failure mode in this design.** `StoredContextCollectionMetadata` is derived from
`ContextCollectionMetadata` (`Omit<…, "content"> & { content?: … }`), so renaming the field renames
it on the storage type too — while already-persisted records still hold `workspaceId`. Left
unnormalized, `getMetadata()` returns `workspaceIds: undefined` for every deployed scoped collection,
`#propagate()` writes that into the owner record, and a collection deliberately narrowed to one
workspace silently becomes readable in **every** workspace its owner has. Silent, and in the widening
direction.

`getMetadata()` already establishes the pattern — it defaults `content` for records that predate git
collections — so the fix is one more defaulted field there, plus the discipline that every write path
reads through `getMetadata()` rather than `storage.metadata.get()` and clears the legacy field.
`docs/superpowers/plans/2026-08-30-multi-workspace-context-collections.md` Task 3 carries a test that
rewrites a record into the legacy shape and asserts the scope survives an unrelated metadata edit.

This is the same tactic the predecessor used for the field's introduction (§10: "Existing collections
keep `visibility: 'private' | 'public'` with `scopedToWorkspace` absent"), applied to its widening.

### 4.4 A declarative setter, not add/remove

The two existing methods are replaced by one:

```ts
/**
 * Set the exact workspaces this collection is scoped to; an empty list returns it to private. Owner
 * only, and never for a public collection: a public collection is domain-owned with no owner library
 * to hold the scope, so scoping it would strand it.
 *
 * Declarative rather than incremental, so the caller states the intended end state and the
 * implementation derives what was added (for the per-workspace budget) and what was removed (for the
 * observer consequence in §7). Two concurrent editors last-write-wins; the operation is owner-only
 * and rare, so a compare-and-set token would be ceremony for a race nobody is running.
 */
setContextCollectionWorkspaces(collectionId: string, workspaceIds: string[]): Promise<void>;
```

Both `setContextCollectionWorkspace` and `revokeContextCollectionWorkspace` are removed. Add, remove,
and revoke-all are all this one call, which keeps the RPC surface *smaller* than today rather than
larger — the `CLAUDE.md` preference for reusing existing mechanisms over adding parallel ones.

The alternative (`addContextCollectionWorkspace` / `removeContextCollectionWorkspace`) was rejected: it
is three methods where one suffices, and it makes "which workspaces were just removed" — the input to
§7's observer consequence — implicit in each call rather than derivable from one diff.

### 4.5 Two caps, because two things can now grow

`MAX_SCOPED_COLLECTIONS_PER_WORKSPACE = 50` is retained and unchanged in meaning: one workspace's
enabled set stays bounded, because every search fans out across it at `MAX_COLLECTION_FANOUT = 8`.

A second cap is added:

```ts
/**
 * How many workspaces one collection may be scoped to. The scope list rides inside a single owned
 * record and inside the summary propagated on every metadata edit, so an unbounded list would grow
 * the hot record without bound.
 */
export const MAX_WORKSPACES_PER_COLLECTION = 20;
```

`MAX_WORKSPACES_PER_COLLECTION` is enforced at the API boundary only (§6.1), alongside
`assertWorkspaceId` — that is where the frame's input first arrives, and it keeps the rejection out of
the Durable Object RPC path, whose cross-stub rejections the Workers test pool reports separately
(see `vitest.workers.config.ts`'s `onUnhandledError` filter for the per-workspace cap). The
per-workspace cap stays in the library, because only the library can count a workspace's collections.

**The budget check must consult only newly added workspaces.** The existing implementation already
carries this trap and documents it: `updateOwnedCollection` is called by `#propagate()` on every
metadata edit with the collection's *unchanged* scope, and counting a record against its own
workspace's budget wrongly rejects a routine edit once that workspace holds exactly the cap. A set
makes the trap easier to fall into, since the naive loop checks every member every time. The rule:
diff old against new, and assert the budget only for workspaces in `new \ old`.

## 5. Data model

### 5.1 Types ([`context-types.ts`](../../../packages/gatekeeper-context/src/context-types.ts))

| Type | Today | Proposed |
|---|---|---|
| `ContextCollectionMetadata` | `workspaceId?: string` | `workspaceIds?: string[]` |
| `ContextCollectionSummary` | `workspaceId?: string` | `workspaceIds?: string[]` |
| `OwnedCollectionRecord` | `scopedToWorkspace?: string` | `scopedToWorkspaces?: string[]` |
| `OwnedRecord` (storage) | `scopedToWorkspace?: string` | `scopedToWorkspaces?: string[]` + deprecated legacy field |
| `EnabledCollectionInfo` | `workspaceId?: string` | `workspaceIds?: string[]` |

`ContextCollectionVisibility` is **unchanged** — still `"public" | "private" | "workspace"` (§4.1).

`EnabledCollectionInfo.source` stays two-valued (`"private" | "public"`), for the reason given in the
predecessor's §6.3: the collection-list sort at
[`ContextLibraryPage.tsx`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx) uses a
comparator that is valid for two values and invalid for three. That sort must stay untouched.

The filter generalizes to:

```ts
/**
 * Whether an owned collection is readable by an agent acting in `workspaceId`. An unscoped
 * collection is readable everywhere; a scoped one only in the workspaces it lists. Passing no
 * `workspaceId` (a caller with no workspace context) excludes every scoped collection.
 */
export function isVisibleInWorkspace(
    scopes: string[] | undefined, workspaceId: string | undefined): boolean {
  return !scopes?.length || (!!workspaceId && scopes.includes(workspaceId));
}
```

The three cases are exactly today's three. Note the added `!!workspaceId` guard: with a string field,
`scopedToWorkspace === undefined` could never equal a caller's absent id by accident; with
`includes()` the guard has to be explicit, or a scope list that somehow contained `undefined` would
match a caller with no workspace. Fail closed.

### 5.2 Audited comparison sites

Every site that reads the singular field. This list is the audit, not a sketch.

| Site | Change |
|---|---|
| [`context-types.ts`](../../../packages/gatekeeper-context/src/context-types.ts) `isVisibleInWorkspace` | signature and body per §5.1 |
| same — `MAX_WORKSPACES_PER_COLLECTION` | new export (§4.5) |
| [`user-library.ts`](../../../packages/gatekeeper-context/src/user-library.ts) `OwnedRecord` | add `scopedToWorkspaces`, deprecate `scopedToWorkspace`, add `recordScopes()` |
| same — `createOwnedCollection` | takes `scopedToWorkspaces?: string[]` |
| same — `#assertScopeBudget` | per-workspace, called only for newly added workspaces (§4.5) |
| same — `updateOwnedCollection` | diff old vs. new scopes; budget-check only additions; write `scopedToWorkspaces`, clear the legacy field |
| same — `listOwnedCollections` | return `scopedToWorkspaces` via `recordScopes()` |
| same — `getEnabledCollections` | `isVisibleInWorkspace(recordScopes(record), workspaceId)`; visibility value is `recordScopes(record).length ? "workspace" : "private"` |
| [`collection-kv.ts`](../../../packages/gatekeeper-context/src/collection-kv.ts) `metadataToSummary` | carry `workspaceIds` |
| [`registry-do.ts`](../../../packages/gatekeeper-context/src/registry-do.ts) | **unchanged** — public-only path, and `syncPublic`'s identity comparison does not read the scope |
| [`context-collection.ts`](../../../packages/gatekeeper-context/src/context-collection.ts) `setWorkspaceScope` / `clearWorkspaceScope` | replaced by one `setWorkspaceScopes(workspaceIds)` (§6.2) |
| same — `StoredContextCollectionMetadata` | admit a deprecated `workspaceId?: string` (§4.3) |
| same — `getMetadata()` | normalize legacy `workspaceId` → `workspaceIds`, beside the existing `content` default (§4.3) — **omitting this silently widens every deployed scoped collection** |
| same — `#propagate()` / `deleteSelf()` / `initialize()` | **unchanged.** All branch `public` vs. everything-else; the scope rides through `metadataToSummary`. Verify, don't assume. |
| [`context-api.ts`](../../../packages/gatekeeper-context/src/context-api.ts) `createContextCollection` | `workspaceId?: string` still singular (§3 non-goal); wraps to a one-element list when storing |
| same — `setContextCollectionWorkspace` / `revokeContextCollectionWorkspace` | replaced by `setContextCollectionWorkspaces` (§4.4) |
| same — `assertWorkspaceId` | applied to every element; also reject duplicates and over-cap lists at the boundary |
| [`library-read.ts`](../../../packages/gatekeeper-context/src/library-read.ts) `loadEnabledContextCollections` | map `scopedToWorkspaces` → `workspaceIds` |
| same — `loadAgentContextCollections` | `isVisibleInWorkspace(collection.workspaceIds, workspaceId)` |
| [`library-gatekeeper.ts`](../../../packages/gatekeeper-context/src/library-gatekeeper.ts) `#scopedCollectionIds` | `.filter(c => c.scopedToWorkspaces?.includes(workspaceId))` |
| same — `getAgentCatalog`'s inline scoped set | `.filter(c => c.workspaceIds?.includes(workspaceId))` |
| same — `#newReadSession`'s scoped set | **unchanged** — it projects from the visibility map (`visibility === "workspace"`), which §4.1 keeps meaningful |
| [`context-observers.ts`](../../../packages/gatekeeper-context/src/context-observers.ts) | **unchanged** (§7) |
| `ContextLibraryPage.tsx` list-row badge | derive from `workspaceIds?.length` |
| `ContextLibraryPage.tsx` collection sort | **unchanged, and must stay that way** (§5.1) |
| `ContextLibraryPage.tsx` Access field | becomes a list (§8.2) |
| `ContextLibraryPage.tsx` kebab actions + revoke modal | become add/remove/stop-all (§8.3) |

## 6. Write path

### 6.1 API boundary ([`context-api.ts`](../../../packages/gatekeeper-context/src/context-api.ts))

`setContextCollectionWorkspaces(collectionId, workspaceIds)`:

1. `#assertCanWrite(collectionId)` — unchanged; the owner check already admits exactly the right person.
2. Normalize: trim, drop empties, de-duplicate. Duplicates would inflate the per-collection cap and
   double-count the per-workspace budget.
3. `assertWorkspaceId` each remaining element. The existing `/^[0-9a-f]{64}$/` check stays at this
   boundary, where the frame's input first arrives, for the reason the predecessor's §7.1 gives: the
   Durable Objects stay unvalidated because a malformed scope there is only ever unreadable, never a
   grant.
4. Reject a list longer than `MAX_WORKSPACES_PER_COLLECTION`.
5. Reject if the collection is public — the existing check and message, unchanged.
6. Delegate to `ContextCollectionDurableObject.setWorkspaceScopes(...)`.

### 6.2 Collection DO ([`context-collection.ts`](../../../packages/gatekeeper-context/src/context-collection.ts))

`setWorkspaceScopes(workspaceIds)` merges today's `setWorkspaceScope` and `clearWorkspaceScope`:

```ts
async setWorkspaceScopes(workspaceIds: string[]): Promise<void> {
  let meta = this.storage.metadata.get();
  if (sameScopes(meta.workspaceIds, workspaceIds)) return;      // idempotent, as today
  this.storage.metadata.put({
    ...meta,
    visibility: workspaceIds.length ? "workspace" : "private",  // §4.1
    workspaceIds: workspaceIds.length ? workspaceIds : undefined,
    lastUpdated: new Date(),
  });
  try {
    await this.#propagate();
  } catch (err) {
    this.storage.metadata.put(meta);                            // rollback
    throw err;
  }
}
```

The rollback is retained verbatim from both methods it replaces, and for both of their reasons: the
per-workspace budget is enforced during propagation, so a rejected scope must not leave metadata
advertising a workspace the owner library never recorded; and the owner-library record is what the
enabled set filters on, so a failed propagation must not leave metadata claiming a narrowing that did
not happen. The idempotent early return makes both mandatory — without the rollback, a retry after a
failure would report success without doing anything.

`sameScopes` compares as sets, not arrays, so a reordered list is a no-op rather than a rewrite.

## 7. Observers: no new concept needed

This is the part that could have been expensive and is not.

[`ContextObserverTracker`](../../../packages/gatekeeper-context/src/context-observers.ts) needs **no
change at all**. It consumes a `ResolveScopedCollections` — "the collections scoped to *this*
workspace" — and that abstraction is already exactly right for a set. Only the closures that produce
it change, and only two of the three do:

- `#scopedCollectionIds()` (the fallback used by `addObserver`/`removeObserver`) and the inline set in
  `getAgentCatalog()` both compare `=== workspaceId` today, and become `.includes(workspaceId)`.
- `#newReadSession()`'s closure is **unchanged**: it projects the scoped set from the visibility map
  the session already resolved (`visibility === "workspace"`), and §4.1 keeps that projection exact.
  This is why the read hot path costs no extra Durable Object reads, and it stays true for a set.

The predecessor's §7.2 consequence generalizes correctly and without new code:

- **Removing a workspace from the set** is a lapsed ground for *that* workspace's facet. Its
  `"observed-scoped"` keys are re-verified on the next observation, the verifier is consulted, and
  collaborators who cannot independently read the collection are excluded — identical to today's full
  revoke, because the ground is "is this collection scoped here *right now*", which the set answers
  just as well as the string did.
- **The other workspaces are untouched.** `gtm1`'s facet reads `gtm1`'s own scoped set, which still
  contains the collection. Removing `gtm2` cannot affect it. This is the property goal 4 asks for,
  and it falls out of the per-facet resolution rather than needing to be built.
- **Re-adding a workspace restores it**, on the same terms as today's re-scope: the tracker skips the
  verifier again and collaborator-adding works immediately.

`ContextVerifier.hasCollectionAccess` is likewise unchanged. It has no workspace context and needs
none; scoped collections are resolved facet-side.

**Testing must pin the isolation property**, because it is the one thing a plausible wrong
implementation (resolving the scoped set once per account instead of per facet) would break silently.
See §9.

## 8. UI ([`ContextLibraryPage.tsx`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx))

### 8.1 Create dialog — unchanged

Still one workspace, still via the host picker, still blocks Create until one is chosen. §3.

### 8.2 The Access field becomes a list

Today the field renders one of three strings, resolving a single title through `resolveWorkspaceTitles`
and showing "One workspace" while the lookup is in flight. It becomes:

- **public** → "Everyone (required)" — unchanged.
- **no scopes** → "Private to you" — unchanged.
- **scoped** → the resolved titles, joined. `resolveWorkspaceTitles` already accepts an array and
  returns positionally, so the existing effect widens from `[id]` to the whole list with no bridge
  change.

The in-flight neutral string generalizes from "One workspace" to a count ("2 workspaces"), for the
reason the existing comment gives: naming the workspaces is the only claim this field can make, and
"no longer available" is not it while a lookup is outstanding. An individual `null` in the resolved
array still renders as "Workspace no longer available" for that entry only — a deleted workspace must
not make its siblings unnameable.

The list-row badge derives from `workspaceIds?.length` instead of the presence of a string.

### 8.3 Actions become add / remove / stop-all

Today's matched pair ("Share with a workspace" / "Stop sharing with this workspace") becomes:

- **Add a workspace** — always offered for a non-public collection under the cap; opens the host
  picker; a workspace already in the set is a no-op rather than an error.
- **Remove**, per workspace, from the Access list rather than the kebab — the kebab cannot express
  "which one" once there are several.
- **Stop sharing with all workspaces** — retained in the kebab for the collection-wide case.

**The revoke confirmation must be kept and made specific.** The predecessor's §7.2 requires it, and
its wording is currently collection-wide ("This collection becomes private to you"). Removing one of
several workspaces does not make the collection private, so the dialog must name the workspace being
removed and state the consequence for *that* workspace only:

> New collaborators can't be added to **gtm2** until this collection is shared with it again.

Confirming removal of the last workspace additionally says the collection becomes private to you.
Getting this wrong tells the owner their collection went private when it did not — the same class of
correctness bug the predecessor's §9.2 flagged in the Source/Access fields.

### 8.4 Copy

`VISIBILITY_OPTIONS`' workspace entry currently reads "Available to everyone chatting in one
workspace, and only there." It becomes "Available to everyone chatting in the workspaces you choose,
and only there." The exclusivity clause is load-bearing (§4.1) and must survive.

## 9. Testing

Extending the predecessor's §11 list rather than replacing it. Existing tests that assert
single-workspace behavior should keep passing through the normalizer, which is itself the migration
test.

- `recordScopes()`: a legacy `scopedToWorkspace` record reads as a one-element set; a record with
  neither field reads as empty; a converted record never retains the legacy field.
- **Legacy metadata (§4.3's second normalization):** a collection whose stored metadata holds
  `workspaceId` rather than `workspaceIds` reads back as scoped, and an unrelated metadata edit
  propagates that scope instead of clearing it. Without this test the widening regression is
  invisible — every other test creates its records in the new shape.
- `isVisibleInWorkspace`: unscoped enabled everywhere; scoped enabled in each of its own workspaces;
  scoped excluded from a workspace not in the set; scoped excluded when `workspaceId` is omitted.
- `getEnabledCollections`: a collection scoped to `{gtm1, gtm2}` is enabled in both and in neither
  `gtm3` nor the no-workspace caller; public still added; owned still wins on overlap.
- `updateOwnedCollection` preserves the full scope set across a metadata edit — the silent-drop bug
  the predecessor called out, now with more to drop.
- **Budget:** a routine metadata edit on a collection in a workspace already at 50 succeeds
  (§4.5's trap); adding a 51st scoped collection to one workspace is rejected; a 21st workspace on
  one collection is rejected; a list containing duplicates is normalized before either cap is applied.
- Exclusivity end to end across all three facet call sites (session, catalog, **slash commands** —
  the predecessor's §6.2 warns that missing the third makes workspace Agent Skills silently vanish):
  a collection scoped to `{gtm1, gtm2}` appears in both and is absent from `gtm3`.
- `listEnabledContextCollections()` still returns the owner's scoped collections with their full
  `workspaceIds`, since it deliberately omits the workspace filter.
- **Observer isolation (§7), the key new test:** with a collection scoped to `{gtm1, gtm2}`, removing
  `gtm2` causes `gtm2`'s tracker to re-verify and reject a collaborator who cannot independently read
  it, while `gtm1`'s tracker still skips the verifier and admits one. Re-adding `gtm2` restores it.
- Regression guard: with only single-workspace collections present, every read path returns exactly
  what it returns today.
- `pnpm lint` (oxlint + recursive `tsc --noEmit`) and `pnpm build` for the touched packages.

## 10. Explicitly deferred

Recorded here because they came up while scoping this work and will otherwise be rediscovered.

- **Scoping into a workspace someone else owns.** Structurally impossible today, and not a UI
  limitation: [`overseer.ts`](../../../packages/workshop-backend/src/overseer.ts) `ensureAmbientCapsules`
  mints a workspace's Context capsule from `#ownerUserDo()`, so a workspace reads its *owner's*
  library. A collection scoped to a workspace its owner does not own is a record nobody reads. This
  needs the cross-account grant below, not a bigger scope list.
- **Cross-account grants** — "share this collection with Priya's account, so her agents read it
  wherever she works." Storage is modest: a second record type (`grantedCollections`) inside the
  existing per-account `UserLibraryDurableObject`, merged into `getEnabledCollections` and into
  `ContextVerifier.hasCollectionAccess`. **The blocker is naming the recipient**: the Context
  gatekeeper has no identity at all (`AppUiContext` is `{ isAdmin: boolean }`, accounts are
  self-generated UUIDs, and `overseer.ts` records that observer ids deliberately withhold identity
  "to avoid tempting gatekeeper authors to parse identity out of it"). A host-bridge `pickUsers()`
  mirroring `pickWorkspace()` would be a `workshop-frontend` + `workshop-backend` change, plus a
  decision about users who have never provisioned a Context account (the vendor defaults to
  `optional`). Note this subsumes the bullet above: granting to the owner of `gtm2` enables the
  collection in every workspace they own.
- **Visibility transitions** (`private` ↔ `public` after creation). Blocked on an entanglement worth
  recording: public collections are created with `ownerAccountId: ""`, and `#propagate()`/`deleteSelf()`
  branch on `visibility === "public"`. So promoting strands the owner-library record (and `hasOwned`
  keeps granting verifier access to a collection that later gets deleted), while demoting has no owner
  to hand the collection to. Fixing it means giving public collections a real owner. Worse, it makes
  `public` a **revocable** ground for observation, which today's sticky `"observed"` marker assumes it
  is not — so it also needs the ground-recording generalization that `"observed-scoped"` introduced.
- **Teams** as a Workshop-wide primitive. Discussed and set aside: it is a kernel concept, and both
  motivating cases above are served by cross-account grants without it.

## 11. File inventory

**`packages/gatekeeper-context`:** `src/context-types.ts`, `src/user-library.ts`, `src/context-api.ts`,
`src/library-read.ts`, `src/library-gatekeeper.ts`, `src/collection-kv.ts`, `src/context-collection.ts`,
`app/ContextLibraryPage.tsx`, plus tests. `src/context-observers.ts` is expected to need **no change**
(§7) — verify, don't assume. `src/generated/app.txt` is regenerated by the package build and is
gitignored.

**`packages/workshop-frontend`:** none. `pickWorkspace()` and `resolveWorkspaceTitles()` already have
the shapes this needs.

**`packages/workshop-shared`:** none. Zero kernel diff.

**No new files, no new Durable Object, no `wrangler.jsonc` change, no release-manifest change, no data
migration.**

**Docs:** none required. `docs/observers.md` §9.2's Strategy C row already says "scoped to the
observer's workspace", which stays true of a set.

## 12. Suggested sequencing

Grouped so storage and read-path correctness can be reviewed apart from the UI.

1. Types, `recordScopes()`, `isVisibleInWorkspace`, and both caps.
2. `UserLibraryDurableObject`: scope persistence, the add-only budget diff, `getEnabledCollections`.
3. Write path: `setWorkspaceScopes` on the collection DO, `setContextCollectionWorkspaces` on the API,
   removal of the two superseded methods.
4. Read path: the three facet closures and `loadAgentContextCollections`.
5. Observer isolation tests (§7 asserts no production change here — the tests are the deliverable).
6. UI: Access list, add/remove/stop-all actions, the per-workspace revoke confirmation, badge, copy.

Steps 1–5 are shippable without 6: the tier works, with no way to add a second workspace from the UI
yet.
