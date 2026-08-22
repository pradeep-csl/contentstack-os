# Workspace visibility for Context & Skills collections

Status: implemented on `feat/workspace-context-visibility` (9 feature commits plus a final
review-fix wave). Revised after critical review, then corrected in three places that implementation
proved wrong — see the notes marked "an earlier draft of this spec".

> **Revision note.** The first draft of this design introduced a per-workspace
> `WorkspaceLibraryDurableObject` holding grants from any account, allowed any build-role member to
> grant, and made `workspace` visibility *additive* (private **plus** shared). Review changed two
> decisions — exclusive scoping (§4.1) and owner-only granting (§4.2) — and together they removed
> the need for the new Durable Object altogether (§4.3). The result is roughly half the surface, no
> deploy-time migration, and no trust placed in the workspace id crossing the frame boundary (§7.1).

## 1. Problem

Context Library collections have two visibilities today ([`context-types.ts`](../../../packages/gatekeeper-context/src/context-types.ts)):

- **private** — owned by one Context account, readable only through that account's agent session.
- **public** — created by deployment admins, readable by everyone in the sharing domain.

There is nothing in between. A team that wants curated knowledge scoped to one workspace — "anyone
chatting in this workspace can draw on these documents and skills" — has to choose between keeping
it to themselves and publishing it deployment-wide, which only an admin can do.

Worse, private collections actively **break collaboration**. The ambient Context capsule in a
workspace is minted from the *workspace owner's* account, so the owner's private collections are
what the workspace agent reads. Once it has read one,
[`ContextObserverTracker.addObserver()`](../../../packages/gatekeeper-context/src/context-observers.ts)
throws for any collaborator who cannot independently read that collection — so you cannot add a
collaborator to the workspace at all. Curated knowledge and shared workspaces are mutually
exclusive today.

Two comments in the code anticipate this feature:

- [`library-read.ts`](../../../packages/gatekeeper-context/src/library-read.ts) — `ResolveEnabledCollections`
  is "injected rather than derived, so a session can be pinned to a subset (**a workspace-scoped
  collection**) without touching the read path."
- [`context-types.ts`](../../../packages/gatekeeper-context/src/context-types.ts) — the `push`
  content source is "deliberately independent of visibility, so **scoped collections** can use the
  same pipeline later."

## 2. Goals

1. A third visibility, **workspace**: a collection whose documents and skills are available to the
   agent of exactly one workspace, for everyone chatting there.
2. Chosen at creation time from the existing New collection dialog, via a dropdown of workspaces.
3. Create is blocked until a workspace is selected, so there is no path to a workspace collection
   without a workspace. A user who owns none meets that in the picker's empty state ("You don't own
   any workspaces yet") rather than a disabled radio: disabling the *option* would require telling
   the frame how many workspaces the user owns, which is the enumeration §4.6 exists to avoid.
4. Reversible: the scope can be removed, returning the collection to private.

## 3. Non-goals

- **Workspace members do not see the collection in their own Context & Skills page.** That page is
  account-scoped and carries no workspace context. Members' *agents* read the collection; members
  do not browse or edit it in the management UI. This is the whole of what was asked for
  ("anyone chatting in that workspace").
- **Only the workspace owner can scope a collection to it** (§4.2). A build-role collaborator
  cannot contribute one. This is a real loss, taken deliberately as the reversible direction.
- **One workspace per collection.** Not a technical limit — see §4.4 — but the create dialog and the
  data model both stay single-valued until there is a reason.
- **No new content source.** Workspace collections use `web` / `git` / `push` exactly as private
  ones do; the axes are independent, as the `push` comment above says.
- **No change to the `prohibitAllSharing` policy** or to any other gatekeeper.

## 4. Decisions taken, with rationale

### 4.1 Exclusive scoping, not additive sharing

Visibility `"workspace"` means the collection is readable **only** through that one workspace's
agent — not through the creator's other workspaces. It is a *narrowing* of private, not private
plus an extra grant.

The first draft had it additive (the collection stayed in the creator's enabled set everywhere, with
the workspace added on top). Rejected: the dialog presents Only me / Workspace / Everyone as three
mutually exclusive choices, and a user picking "Workspace" to scope project knowledge to a project
would be surprised to find it feeding every other workspace they own. Narrower is also the right
default for a new sharing surface.

The creator retains full management access (they own it) — they simply cannot *read it through an
agent* anywhere else.

### 4.2 Only the workspace owner may scope a collection to it

The Workshop mints the ambient Context capsule from the **workspace owner's** account
([`overseer.ts` `ensureAmbientCapsules`](../../../packages/workshop-backend/src/overseer.ts)), so the
owner is the one account whose collections that workspace's agent reads. Restricting scoping to
workspace owners makes "who can add knowledge" identical to "who controls the workspace".

This resolves three problems the first draft carried:

1. A workspace owner could not remove a collection someone else had pushed into their workspace.
2. Scoping to a workspace whose owner has no Context account (the vendor is `optional` and they
   never opted in, or `disabled`) wrote a grant that nothing would ever read — a silent no-op.
3. Cross-user knowledge injection into someone else's agent was possible in principle (§7.1).

### 4.3 Therefore: no new Durable Object

Given §4.1 and §4.2, every scope relevant to a facet necessarily lives in **that facet's own
account's library**: the facet is minted from the owner's account, and the owner is the only
possible granter. So the scope is one field on the existing owned-collection record, and the
per-workspace index the first draft proposed has nothing to hold.

Removed as a result: a new DO class, a `wrangler.jsonc` migration tag, a release-manifest golden
update, dual-index writes with a rollback path, second-index propagation on every metadata edit, and
a grant-cleanup step in `ContextAccount.revoke()`. This is the `CLAUDE.md` preference for "reusing
existing mechanisms over adding parallel ones", arrived at the hard way.

### 4.4 The scope is a field, so multi-workspace stays open

`scopedToWorkspace?: string` is single-valued. Widening it later to a set is a local change to the
owner record and the one filter that reads it — no new storage and no migration of existing
records, which all have the field absent.

### 4.5 The workspace id comes from facet inheritance

The Context singleton is installed as a **Facet under the workspace's Overseer**
([`overseer.ts:2663`](../../../packages/workshop-backend/src/overseer.ts) — `ctx.facets.get('gatekeeper<id>', …)`),
so inside `ContextGatekeeper` the inherited `this.ctx.id.toString()` *is* the workspace id.

Verified, not assumed:

- [`gatekeeper-scheduler/__tests__/scheduler-scope.test.ts`](../../../packages/gatekeeper-scheduler/__tests__/scheduler-scope.test.ts)
  asserts that sibling facet names under one parent inherit the parent's id, and that different
  parents stay isolated. `gatekeeper-context` now carries the same tripwire. **Known limit:** both
  open the facet from their own test worker, so they guard workerd's inheritance behaviour, not the
  Workshop call site — adding an `id:` override to `getGatekeeperFacet` (`overseer.ts`) would break
  every scoped collection without failing either test. Guarding that needs a `workshop-backend` test
  asserting the override's absence; it is not written.
- The id the frontend calls a workspace id is the same string: workspaces are created with
  `this.overseers.newUniqueId().toString()` and reopened with `idFromString`
  ([`server.ts`](../../../packages/workshop-backend/src/server.ts)).

**So the read path needs no `workshop-shared` change at all** — no new field on `AppUiContext`, no
new method on `GatekeeperUser`. Zero kernel diff on the read side.

Incidental finding: [`api.ts`](../../../packages/workshop-shared/src/api.ts) documents
`GadgetMetadata.id` as "a url-safe base64 value chosen randomly", but a
`DurableObjectId.toString()` is 64 hex characters. The comment is stale; worth a separate one-line
fix.

### 4.6 A host-filled dropdown, not an enumeration

The requested UX is a dropdown of workspaces inside the New collection dialog. The gatekeeper app
runs in an opaque-origin `srcDoc` frame and **cannot be handed the workspace list**: the host
bridge's title lookup is documented as
["Deliberately a lookup, not an enumeration: the app learns nothing new"](../../../packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx).
Adding a `listWorkspaces()` there would relax that invariant for *every* gatekeeper app, including
third-party ones such as the MCP portal — every connector UI could then enumerate the user's
workspace names and ids. A bad trade for one dropdown.

So the control looks and behaves like a `<select>`, but opening it asks the **host** to present the
list; the app learns only the one workspace the user picks. The host already owns this class of
interaction (`openWorkspace`, `resolveWorkspaceTitles`, `setPresenting`).

## 5. Data model

### 5.1 Types ([`context-types.ts`](../../../packages/gatekeeper-context/src/context-types.ts))

```ts
export type ContextCollectionVisibility = "public" | "private" | "workspace";
```

- `ContextCollectionMetadata` gains `workspaceId?: string` — "the workspace this collection is
  scoped to; set if and only if visibility is `workspace`".
- `ContextCollectionSummary` gains the same field, so it survives the denormalized round trip
  through `metadataToSummary` → `updateOwnedCollection`.
- `OwnedCollectionRecord` (and the storage-side `OwnedRecord`) gain `scopedToWorkspace?: string`.
- `EnabledCollectionInfo` gains `workspaceId?: string`. **Its `source` union is deliberately left
  at `"private" | "public"`** — see §6.3.

`ContextApi.createContextCollection` gains a trailing `workspaceId?: string`, required when
`visibility === "workspace"` and rejected otherwise. Two methods are added for goal 4:

```ts
/**
 * Scope a private collection to a workspace, or move it between workspaces. Owner only; rejects a
 * public collection (domain-owned, so no owner account could manage it) and is idempotent for the
 * scope it already holds. This is what makes §7.2's remedy real, and implementation showed it is
 * load-bearing rather than optional: without it, revoking leaves the workspace permanently
 * unshareable.
 */
setContextCollectionWorkspace(collectionId: string, workspaceId: string): Promise<void>;
/** Drop the workspace scope, returning the collection to private. Owner only. */
revokeContextCollectionWorkspace(collectionId: string): Promise<void>;
```

### 5.2 Audited comparison sites

Widening `ContextCollectionVisibility` breaks every exhaustive comparison against it. This list is
the audit, not a sketch:

| Site | Change |
|---|---|
| [`context-api.ts`](../../../packages/gatekeeper-context/src/context-api.ts) `createContextCollection` — `visibility === "public"` admin gate | unchanged; workspace needs no admin |
| same — `initialize(..., visibility === "private" ? accountId : "")` | **must include `"workspace"`**: scoped collections have a creator-owner. Missing this makes the collection ownerless and unmanageable. |
| same — index-write branch | `"workspace"` follows the private path (owner library), with `scopedToWorkspace` set |
| [`context-collection.ts`](../../../packages/gatekeeper-context/src/context-collection.ts) `#propagate()` and `deleteSelf()` | **unchanged.** Both branch `public` vs. everything-else, and workspace belongs with private. `workspaceId` rides through `metadataToSummary`, so no new dispatch. |
| [`registry-do.ts`](../../../packages/gatekeeper-context/src/registry-do.ts) `syncPublic` | unchanged (public-only path) |
| [`collection-kv.ts`](../../../packages/gatekeeper-context/src/collection-kv.ts) `metadataToSummary` | carry `workspaceId` through |
| [`user-library.ts`](../../../packages/gatekeeper-context/src/user-library.ts) `updateOwnedCollection` | persist `scopedToWorkspace` from the summary — it rebuilds fields from the summary, so omitting this **silently drops the scope on the next metadata edit** |
| [`ContextLibraryPage.tsx:1159`, `:1240-1252`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx) | see §6.2 — a correctness fix, not cosmetics |
| [`ContextLibraryPage.tsx:310`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx) | badge from the new `workspaceId`, see §6.3 |
| [`ContextLibraryPage.tsx:987`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx) sort | **unchanged, and must stay that way** — see §6.3 |

`initialize()` itself is visibility-agnostic (verified), so it needs no change.

## 6. Read path

### 6.1 One parameterized resolver

`UserLibraryDurableObject.getEnabledCollections(domain, workspaceId?)` filters owned records:

- `scopedToWorkspace` absent → always enabled.
- `scopedToWorkspace === workspaceId` → enabled.
- `scopedToWorkspace` set to anything else (or `workspaceId` omitted) → **excluded**.

Then public collections are added as today, owned still winning on overlap. Passing no
`workspaceId` therefore yields the pre-existing behavior minus scoped collections, which is exactly
right for any non-workspace caller.

[`accountEnabledCollections`](../../../packages/gatekeeper-context/src/library-read.ts) gains the
same optional argument and forwards it. No second resolver function — the injection point the
existing comment promised is enough.

`ContextGatekeeper` gains `#workspaceId()` returning `this.ctx.id.toString()`, with the scheduler's
smoke check that the inherited id is not the account id.

### 6.2 Three call sites, not one

All three of these resolve the enabled set and must pass the workspace id:

1. `#newReadSession()` → `startSession()` — search / list / read.
2. `getAgentCatalog()` — discovery metadata.
3. `#listSlashCommands()` via `loadEnabledContextCollections()` — **miss this one and workspace
   Agent Skills silently fail to appear as slash commands.**

`loadEnabledContextCollections(env, domain, userLibrary, workspaceId?)` takes the same optional
argument, and the distinction matters in both directions:

- The three facet call sites **pass it** → scoped collections belonging to other workspaces are
  filtered out.
- `ContextApi.listEnabledContextCollections()` **omits it deliberately** and instead includes all
  owned records, scoped ones among them, carrying `workspaceId` so the UI can badge them. This is
  the management listing; hiding the creator's own scoped collection from their own library page
  would be a bug, not exclusivity.

### 6.3 Why `EnabledCollectionInfo.source` stays two-valued

It would be natural to add `source: "workspace"`. Don't:

- [`:987`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx) sorts with
  `if (a.source !== b.source) return a.source === "public" ? -1 : 1`. That is a valid comparator for
  two values and an **invalid** one for three — `compare(private, workspace)` and
  `compare(workspace, private)` both return `1`, making the order implementation-defined. A silent
  regression, unlike the loud ones.
- Under §4.2 a scoped collection is always the viewer's own, so `"private"` remains truthful.
  `workspaceId` carries the extra bit, and `:310` badges from that.

Catalog ordering is unaffected, though not for the reason an earlier draft of this spec gave: there
is no "owned block" for scoped collections to sit inside — `buildContextCatalog` re-sorts entries by
title. They are simply more entries in that sort, so the Workshop's tail-dropping `AgentCatalog`
clamp behaves exactly as it does today.

### 6.4 Per-workspace cap

`MAX_SCOPED_COLLECTIONS_PER_WORKSPACE = 50`, enforced in the user library when scoping. Every search
fans out across the whole enabled set at `MAX_COLLECTION_FANOUT = 8`, so an unbounded scope count
would degrade every search in that workspace. `gatekeeper-scheduler` sets the precedent with
`MAX_ENABLED_SCHEDULES_PER_WORKSPACE`.

## 7. Observers and information flow

[`docs/observers.md`](../../observers.md) §9.2 classifies the Context Library singleton as
**Strategy C** (data-set tracking), with collections as the data sets and this oracle: "public in
the sharing domain, or privately owned by the observer's Context account".

This change adds a **third ground for access that is structural rather than an oracle**: a
collection scoped to workspace W is accessible to every observer of W's facet, because an observer
*is* a collaborator on W by construction. There is nothing to ask a verifier.

- `ContextObserverTracker` learns which collections in play are scoped to its own workspace and
  **omits those from verifier queries** in both `prepareObservation()` and `addObserver()`. The set
  comes from the same owner-library read the enabled set uses.
- [`ContextVerifier.hasCollectionAccess`](../../../packages/gatekeeper-context/src/library-gatekeeper.ts)
  is **unchanged**. It has no workspace context and needs none; a comment records that scoped
  collections are resolved facet-side.
- Scoped reads are still **recorded as observed** — see §7.2.
- The Strategy C row in `docs/observers.md` §9.2 gains the third ground.

This is what dissolves the collaboration deadlock in §1: a workspace collection never excludes that
workspace's own collaborators.

### 7.1 No trust in the workspace id — structurally

The app passes a `workspaceId` the gatekeeper cannot verify, since only the Workshop knows workspace
membership. Under §4.1 + §4.2 **this requires no trust at all**: a facet reads only *its own
account's* library, so a record scoped to a workspace the creator does not own is read by nobody. A
false workspace id does not inject anything anywhere — it makes the collection unreadable
everywhere, visible in the UI as a scope whose title will not resolve (§8).

Restricting the host picker to owned workspaces is therefore **UX, not a security control**: it
keeps users from creating inert collections. The security property holds even if the frame lies.

### 7.2 Revoking a scope blocks new collaborators — and re-scoping restores it

Observed-collection keys persist in the facet's storage, and they must: the workspace's chat log
already contains that collection's data, and a collaborator added later can read the log. Self-
healing the keys when a scope is dropped would leak exactly what the mechanism exists to prevent.

So after a revoke, `addObserver` consults the verifier for that collection and **throws for any new
collaborator** — including collaborators with no connection to it, and with an error naming a
collection they cannot see.

The saving grace, which the UI should say out loud: **re-scoping the collection to that workspace
restores collaborator-adding immediately**, because the tracker skips the verifier again. The state
is recoverable, mirroring the deliberately reversible lazy-revocation model in
[`sharing.ts`](../../../packages/workshop-backend/src/sharing.ts).

Required, therefore:

- A confirming dialog on revoke that states the consequence plainly ("New collaborators cannot be
  added to *Q3 Launch Plan* until this collection is re-scoped to it or the workspace stops using
  it").
- The thrown message in `context-observers.ts` reworded to name the cause and the remedy, since it
  surfaces in the Workshop's sharing UI.

### 7.3 Admins cannot moderate workspace collections

`#assertCanWrite` is `owns || (isPublic && isAdmin)`, so a deployment admin can edit public
collections but not another user's workspace-scoped one — the same position they are in for private
collections. Stated rather than stumbled into; no change proposed.

## 8. Lifecycle

`#assertCanRead` / `#assertCanWrite` need **no change**: the creator owns the collection, so the
existing owner check admits exactly the right person.

| Event | Behavior |
|---|---|
| create with `visibility: "workspace"` | Reject a missing/blank `workspaceId`; enforce §6.4's cap. `initialize()` with the creator as `ownerAccountId`. One index write (owner library), with `scopedToWorkspace` set. No second index, so no rollback path. |
| metadata edit | `#propagate()` unchanged; `workspaceId` rides through the summary. |
| delete collection | unchanged. |
| `revokeContextCollectionWorkspace` | clear `scopedToWorkspace` and `metadata.workspaceId`, set visibility `private`, propagate. See §7.2 for the observer consequence. |
| account `revoke()` | **unchanged.** The scope is a field on the owned record and dies with it — the dangling-grant cleanup the first draft needed no longer exists. |
| workspace deleted | The facet disappears with the Overseer. The collection survives, still owned and editable, but readable by no agent. `resolveWorkspaceTitles` already returns `null` for a workspace the user can no longer see, so the settings pane shows "Workspace no longer available" with the revoke action beside it. |
| workspace's owner has no Context account | Cannot arise: under §4.2 the granter is the owner, and they are using the Context UI. |

## 9. UI

### 9.1 Host bridge ([`SandboxedGatekeeperApp.tsx`](../../../packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx))

One method on `GatekeeperAppHostImpl`:

```ts
// Present the Workshop's own workspace picker and return only what the user chose. Deliberately a
// pick, not an enumeration: the app learns one workspace, never the list.
pickWorkspace(): Promise<{ id: string; title: string } | null>
```

Backed by a Workshop-owned modal over the existing workspace listing (`listGadgets()`, surfaced as
the sidebar list), filtered to workspaces the user **owns** — which is exactly
`GadgetMetadata.owner === undefined` ([`api.ts`](../../../packages/workshop-shared/src/api.ts):
"Presence of this field indicates the user is a collaborator, not the owner"). Note that `role` is
*not* the right filter: the owner is always `build`, but so is a build-role collaborator. No new
backend data is needed. Returns `null` on cancel.

The create view is a **full-pane view, not a modal**, so the app is not in `setPresenting` overlay
mode when the picker opens. If it ever is, the host declines rather than rendering a modal beneath a
full-viewport iframe.

### 9.2 The app ([`ContextLibraryPage.tsx`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx))

- A third `VISIBILITY_OPTIONS` entry: **Workspace** — "Available to everyone chatting in one
  workspace, and only there." The copy must convey exclusivity (§4.1). Offered to all users, unlike
  "Everyone".
- Selecting it reveals the control: `Choose workspace…` → host picker → chosen title with a change
  affordance.
- **Create collection stays disabled** while visibility is `workspace` and nothing is chosen.
- A user owning no workspace learns so from the picker's empty state, not a disabled radio (Goal 3).
- **The Visibility group must be un-gated first.** It is currently wrapped in `{isAdmin && (`, so
  non-admins see no Visibility control at all and get `private` implicitly. Adding the option inside
  that block would make the whole tier admin-only. The group becomes unconditional and the `public`
  option alone is filtered to admins — a deliberate UI change for non-admins, who go from no
  Visibility section to one offering Only me / Workspace.
- **The settings pane's Source/Access fields must stop being binary.** Today
  [`:1240-1252`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx) renders
  `isPublic ? … : …`, which would label a workspace-scoped collection **"You" / "Private to you"** —
  telling the creator a collection is private while it feeds another workspace's agent. This is a
  correctness fix, not a cosmetic one. It becomes three-valued, showing the workspace title
  (resolved live through `resolveWorkspaceTitles`, `null` → "no longer available") plus the revoke
  action from §7.2.
- List rows badge from `EnabledCollectionInfo.workspaceId` at
  [`:310`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx); the sort at `:987` is
  left alone (§6.3).

## 10. Deploy and migration

- **No `wrangler.jsonc` change, no migration tag, no release-manifest change.** §4.3 removed the new
  DO class; this worker declares no `durable_objects` binding (it reaches DOs via `ctx.exports`) and
  gains no new class, so the manifest's verbatim migration history is untouched and the golden-file
  test stays green.
- The gatekeeper app bundle is generated into `src/generated/app.txt` by `build-app.mjs`. **It is
  gitignored** (`.gitignore:9`) and regenerated by the package build, so it is not committed — an
  earlier draft of this spec claimed otherwise and was wrong.
- **No data migration.** Existing collections keep `visibility: "private" | "public"` with
  `scopedToWorkspace` absent, which §6.1 reads as "always enabled" — their behavior is byte-for-byte
  what it is today.

## 11. Testing

- `getEnabledCollections(domain, workspaceId?)`: unscoped always enabled; scoped enabled only for
  its own workspace; scoped excluded when `workspaceId` is omitted; public still added; owned still
  wins on overlap.
- Exclusivity end to end: a collection scoped to W is absent from workspace X's session, catalog,
  **and slash commands** (all three of §6.2).
- `listEnabledContextCollections()` still returns the creator's scoped collections (§6.2's other
  direction).
- `updateOwnedCollection` preserves `scopedToWorkspace` across a metadata edit — the silent-drop bug
  in §5.2.
- `ContextObserverTracker`: a scoped collection skips verifier queries and never excludes an
  observer; after revoke the verifier **is** consulted and rejects; after re-scoping,
  `addObserver` succeeds again (§7.2).
- The §6.4 cap rejects the 51st scope.
- The facet's inherited workspace id is not the account id.
- Regression guard: with no scoped collections anywhere, every read path returns exactly what it
  returns today.
- `pnpm lint` (oxlint + recursive `tsc --noEmit`) and `pnpm build` for the touched packages.

## 12. File inventory

**`packages/gatekeeper-context`:** `src/context-types.ts`, `src/user-library.ts`,
`src/context-api.ts`, `src/library-read.ts`, `src/library-gatekeeper.ts`, `src/context-observers.ts`,
`src/collection-kv.ts`, `app/ContextLibraryPage.tsx`, `app/bridge.ts`, `src/generated/app.txt`
(regenerated). `src/context-collection.ts` is expected to need **no change** — verify, don't assume.

**`packages/workshop-frontend`:** `src/SandboxedGatekeeperApp.tsx`, plus the picker modal and its
workspace-list source.

**`packages/workshop-shared`:** none. The read path rides on facet id inheritance (§4.5) and the
picker is a frontend host-bridge concern, so the kernel API is untouched.

**No new files, no new Durable Object, no `wrangler.jsonc` change.**

**Docs:** `docs/observers.md` §9.2 (Strategy C row); optionally the stale `GadgetMetadata.id`
comment in `api.ts` (§4.5) and the stale golden-manifest command in the root `CLAUDE.md`
(`scripts/release-manifest.test.js` → `scripts/release/manifest-lib.test.ts`).

## 13. Suggested sequencing

Grouped so the security-relevant internals can be reviewed apart from the UI.

1. Types + `getEnabledCollections` filter + the §6.4 cap + `updateOwnedCollection` persistence.
2. Write path: create with a scope, revoke a scope.
3. Read path: thread the workspace id through all three facet call sites.
4. Observers: skip verifier queries for scoped collections; reword the throw; update
   `docs/observers.md`.
5. Host bridge `pickWorkspace()` + the Workshop picker modal.
6. The app: third radio, dropdown, disabled-Create validation, the three-valued Source/Access
   fields, the list badge, and the revoke confirmation.

Steps 1–4 are shippable without 5–6: the tier exists and works, with no way to create one from the
UI yet.
