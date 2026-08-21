# Workspace visibility for Context & Skills collections

Status: approved design, not yet implemented.

## 1. Problem

Context Library collections have two visibilities today ([`context-types.ts`](../../../packages/gatekeeper-context/src/context-types.ts)):

- **private** — owned by one Context account, readable only through that account's agent session.
- **public** — created by deployment admins, readable by everyone in the sharing domain.

There is nothing in between. A team that wants curated knowledge scoped to one workspace — "anyone
chatting in this workspace can draw on these documents and skills" — has to choose between keeping
it to themselves and publishing it deployment-wide (which only an admin can do).

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
   agent of one named workspace, for everyone chatting there.
2. Chosen at creation time from the existing New collection dialog, via a dropdown of workspaces.
3. Create is blocked until a workspace is selected; with no eligible workspace the option is
   offered but disabled, so the only way forward is Only me / Everyone.
4. Reversible: a grant can be removed, returning the collection to private.

## 3. Non-goals

- **Workspace members do not see the collection in their own Context & Skills page.** That page is
  account-scoped and carries no workspace context. Members' *agents* read the collection; members
  do not browse or edit it in the management UI. This is the whole of what was asked for
  ("anyone chatting in that workspace").
- **No multi-workspace grants in the create dialog.** The schema supports many-to-many for free, so
  this stays available later without a migration.
- **No new content source.** Workspace collections use `web` / `git` / `push` exactly as private
  ones do.
- **No change to the `prohibitAllSharing` policy** or to any other gatekeeper.

## 4. Decisions taken, with rationale

### 4.1 Grant model, not workspace ownership

A workspace collection is **stored exactly like a private one** — owned by its creator's Context
account, indexed in their `UserLibraryDurableObject` — plus a *grant* recorded in a new
per-workspace index. Visibility `"workspace"` means "mine, and readable by that workspace's agent".

Rejected alternative: making the collection *owned* by the workspace, editable by any build-role
member and deleted with the workspace. That needs a workspace-owned index DO **and** a way for the
gatekeeper to learn the caller's role in a workspace, which the account-scoped `ContextApi` has no
access to — the host would have to assert per-workspace roles across the frame boundary. The grant
model needs neither: the creator is the owner, so
[the existing `#assertCanWrite` owner check](../../../packages/gatekeeper-context/src/context-api.ts)
already admits exactly the right person, unchanged.

Consequence, accepted: only the creator can edit or delete the collection. Other members' agents
read it.

### 4.2 Index by workspace, not by account

The grant lives in a per-workspace index rather than as a list on the creator's account. This gives
a property worth having: if a *collaborator* grants their collection to the workspace, the owner's
ambient facet picks it up too, because the facet resolves grants by workspace id. Membership, not
ownership, is the access axis.

### 4.3 A DO index, not a KV snapshot

Public collections are mirrored to KV because every user session in the domain reads the same one
key ([`collection-kv.ts`](../../../packages/gatekeeper-context/src/collection-kv.ts)). A workspace
grant is read by exactly one facet, so a strongly-consistent DO read is both cheaper and simpler —
no snapshot rewrite, no single-key write contention, no staleness window.

### 4.4 The workspace id comes from facet inheritance

The Context singleton is installed as a **Facet under the workspace's Overseer**, so inside
`ContextGatekeeper` the inherited `this.ctx.id.toString()` *is* the workspace id.
[`gatekeeper-scheduler` already relies on exactly this](../../../packages/gatekeeper-scheduler/src/scheduler.ts),
including a smoke check that the inherited id is not the account id, with a workerd
parent/facet-inheritance test behind it.

**This means the agent read path needs no `workshop-shared` change at all** — no new field on
`AppUiContext`, no new method on `GatekeeperUser`. Zero kernel diff on the read side.

### 4.5 A host-filled dropdown, not an enumeration

The requested UX is a dropdown of workspaces inside the New collection dialog. The gatekeeper app
runs in an opaque-origin `srcDoc` frame and **cannot be handed the workspace list**: the host
bridge's title lookup is documented as
["Deliberately a lookup, not an enumeration: the app learns nothing new"](../../../packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx).
Adding a `listWorkspaces()` to that bridge would relax the invariant for *every* gatekeeper app,
including third-party ones such as the MCP portal — every connector UI could then enumerate the
user's workspace names and ids. That is a bad trade for one dropdown.

So the control looks and behaves like a `<select>` in the form, but opening it asks the **host** to
present the list; the app learns only the one workspace the user picks. The host already owns this
class of interaction (`openWorkspace`, `resolveWorkspaceTitles`, `setPresenting`).

## 5. Data model

### 5.1 Types ([`context-types.ts`](../../../packages/gatekeeper-context/src/context-types.ts))

```ts
export type ContextCollectionVisibility = "public" | "private" | "workspace";
```

`ContextCollectionMetadata` gains:

```ts
/** The workspace this collection is granted to. Set if and only if visibility is "workspace". */
workspaceId?: string;
```

This field is what lets the collection DO reach the right index during propagation and deletion.
`ContextCollectionSummary` and `OwnedCollectionRecord` gain the same optional field, so the
creator's collection list can render a "Workspace" badge without a second round trip.

`EnabledCollectionInfo["source"]` gains `"workspace"`.

`ContextApi.createContextCollection` gains a trailing `workspaceId?: string` parameter, required
when `visibility === "workspace"` and rejected otherwise.

Two methods are added to `ContextApi` for the reversibility goal:

```ts
/** The workspace this collection is granted to, if any. Owner/admin only. */
getContextCollectionWorkspace(collectionId: string): Promise<string | null>;
/** Remove the workspace grant, returning the collection to private. Owner only. */
revokeContextCollectionWorkspace(collectionId: string): Promise<void>;
```

(Granting an *additional* workspace post-creation is deferred; see non-goals.)

Widening `ContextCollectionVisibility` is a breaking widening for every comparison against it. The
audited set is exhaustive:

| Site | Change |
|---|---|
| [`context-api.ts` `createContextCollection`](../../../packages/gatekeeper-context/src/context-api.ts) — `visibility === "public"` admin gate | unchanged; workspace needs no admin |
| same file — `initialize(..., visibility === "private" ? accountId : "")` | **must include `"workspace"`**: workspace collections have a creator-owner |
| same file — index write branch | three-way: workspace writes owner library **and** workspace library |
| [`context-collection.ts` `#propagate()`](../../../packages/gatekeeper-context/src/context-collection.ts) | three-way dispatch |
| same file — `deleteSelf()` | three-way dispatch |
| [`registry-do.ts` `syncPublic`](../../../packages/gatekeeper-context/src/registry-do.ts) — `existing.visibility !== summary.visibility` | unchanged (public-only path) |
| [`collection-kv.ts` `metadataToSummary`](../../../packages/gatekeeper-context/src/collection-kv.ts) | carry `workspaceId` through |
| [`ContextLibraryPage.tsx`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx) — `isPublic = metadata.visibility === "public"` and its label | add the workspace case |

### 5.2 New `WorkspaceLibraryDurableObject` (`workspace-library.ts`)

One instance per `(sharingDomain, workspaceId)`, addressed by the existing
[`domainName(domain, workspaceId)`](../../../packages/gatekeeper-context/src/domain.ts) helper
(NUL-separated; a workspace id is hex, so no escaping concern). Modelled directly on
[`registry-do.ts`](../../../packages/gatekeeper-context/src/registry-do.ts):

```ts
grantedCollections: collection<ContextCollectionSummary>()({ primaryKey: "id" })
```

Methods: `addGranted(summary)`, `removeGranted(id)`, `syncGranted(summary)`, `hasGranted(id)`,
`listGranted()`, `getEnabledCollections()`. No KV snapshot (§4.3), so `syncGranted` writes
unconditionally — the conditional-rewrite dance in `syncPublic` exists only to protect a shared KV
key and has no analogue here.

## 6. Read path

`ContextGatekeeper` gains:

```ts
#workspaceId(): string   // this.ctx.id.toString(), with the scheduler's smoke check
```

and a new resolver beside
[`accountEnabledCollections`](../../../packages/gatekeeper-context/src/library-read.ts):

```ts
export function workspaceEnabledCollections(
    userLibraries, workspaceLibraries, domain, accountId, workspaceId): ResolveEnabledCollections
```

returning own private + all public + everything granted to this workspace. Owned wins on overlap,
matching `getEnabledCollections`'s existing rule that private is never downgraded.

**Three call sites, not one.** All of these currently resolve the enabled set and must use the
workspace-aware resolver:

1. `#newReadSession()` → `startSession()` — search / list / read.
2. `getAgentCatalog()` — discovery metadata.
3. `#listSlashCommands()` via `loadEnabledContextCollections()` — **miss this one and workspace
   Agent Skills silently fail to appear as slash commands.**

`loadEnabledContextCollections(env, domain, userLibrary)` therefore takes an optional workspace
library. Its other caller, `ContextApi.listEnabledContextCollections()`, is account-scoped and
passes nothing — correct, since the creator already sees their own collection through their user
library.

## 7. Observers and information flow

[`docs/observers.md`](../../observers.md) §9.2 classifies the Context Library singleton as
**Strategy C** (data-set tracking), with collections as the data sets and this access oracle:
"public in the sharing domain, or privately owned by the observer's Context account".

This change adds a **third ground for access that is structural rather than an oracle**: a
collection granted to workspace W is accessible to every observer of W's facet, because an observer
*is* a collaborator on W by construction. There is nothing to ask a verifier.

So:

- `ContextObserverTracker` learns which of the collections in play are granted to its own
  workspace, and **omits those from verifier queries** in both `prepareObservation()` and
  `addObserver()`. The grant set is resolved by the facet, which knows its workspace id.
- [`ContextVerifier.hasCollectionAccess`](../../../packages/gatekeeper-context/src/library-gatekeeper.ts)
  is **unchanged**. It has no workspace context and needs none; a comment will record that
  workspace grants are resolved facet-side rather than through the verifier.
- Workspace-granted reads are still **recorded as observed**. If the grant is later revoked, a new
  observer is again checked and rejected. The data genuinely was revealed, so the strict behavior is
  correct.
- The Strategy C row in `docs/observers.md` §9.2 is updated, since it enumerates the grounds.

This is what dissolves the collaboration deadlock in §1: a workspace collection never excludes a
workspace's own collaborators.

### 7.1 Trust boundary, stated explicitly

The gatekeeper **trusts the `workspaceId` the app passes at creation.** It cannot verify workspace
membership: only the Workshop knows it.

- A workspace id is a 64-hex DO id, unguessable, and the host will only offer workspaces where the
  user has **build** access.
- Residual risk: a member who knows a workspace id could grant a collection into it. The
  consequence is knowledge *injection* into that workspace's agent — not data exfiltration, since a
  grant only ever *adds* readable content. Context documents are already presented to the agent as
  untrusted data, which is why the deployment-wide "Everyone" tier is admin-gated.
- Restricting the host picker to build-access workspaces is the mitigation. The stronger version —
  the host asserting the workspace per-open, the way `isAdmin` is asserted in `AppUiContext` — is
  available later **without a data migration**, since the stored grant is identical either way.

## 8. Write path and lifecycle

`#assertCanRead` / `#assertCanWrite` in
[`context-api.ts`](../../../packages/gatekeeper-context/src/context-api.ts) need **no change**: the
creator owns the collection, so the existing owner check admits exactly the right person.

| Operation | Behavior |
|---|---|
| `createContextCollection(visibility: "workspace", workspaceId)` | Reject a missing/blank `workspaceId`. `initialize()` with the creator as `ownerAccountId`. Write **both** the owner library and the workspace library. On either index write failing, delete the unreachable collection — same rollback the public path already performs. |
| metadata edit (`#propagate()`) | Refresh the denormalized summary in **both** indexes. |
| `deleteContextCollection` / `deleteSelf()` | `removeOwnedCollection` **and** `removeGranted`. |
| `revokeContextCollectionWorkspace` | `removeGranted`, clear `metadata.workspaceId`, set visibility `private`, propagate. |
| account `revoke()` | Owned collections are deleted via `deleteForRevokedOwner()`, which wipes storage without touching indexes ("the user-library index is cleared separately"). **A workspace grant is not in the user library**, so `ContextAccount.revoke()` must additionally remove each owned collection's grant from its workspace library before wiping, or the workspace keeps a dangling summary. This is the one lifecycle hole a naive implementation would leave. |
| workspace deleted | The facet disappears with the Overseer; the `WorkspaceLibraryDurableObject` becomes unreachable and its grants inert. The collection itself survives in the creator's library. No orphaned content — the deliberate payoff of the grant model over workspace ownership. |

## 9. UI

### 9.1 Host bridge ([`SandboxedGatekeeperApp.tsx`](../../../packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx))

One method on `GatekeeperAppHostImpl`:

```ts
// Present the Workshop's own workspace picker and return only what the user chose. Deliberately a
// pick, not an enumeration: the app learns one workspace, never the list.
pickWorkspace(): Promise<{ id: string; title: string } | null>
```

Backed by a Workshop-owned modal fed by the existing workspace listing (`listGadgets()`, surfaced
in the frontend as the sidebar workspace list), filtered to build access — the listing already
carries the viewer's effective `role` per workspace (`api.ts`: "The owner is always `build`"), so
the filter needs no new backend data. Returns `null` on cancel.

The create view is a **full-pane view, not a modal**, so the app is not in `setPresenting` overlay
mode when the picker opens. If it ever is, the host declines rather than rendering the modal beneath
a full-viewport iframe.

### 9.2 The app ([`ContextLibraryPage.tsx`](../../../packages/gatekeeper-context/app/ContextLibraryPage.tsx))

- A third entry in `VISIBILITY_OPTIONS`: **Workspace** — "Available to everyone chatting in one
  workspace." Shown to all users (unlike "Everyone", which stays admin-only).
- Selecting it reveals the workspace control: `Choose workspace…` → host picker → the chosen title,
  with a change affordance.
- **Create collection stays disabled** while visibility is `workspace` and nothing is chosen.
- The eligible-workspace count comes from the same host call; with none, the option renders disabled
  with the hint "Create a workspace first".
- The collection's settings pane shows the workspace chip, its title resolved live through the
  existing `resolveWorkspaceTitles` so it never renders a stale snapshot, plus a remove-grant
  action.

## 10. Deploy and migration

- **No `durable_objects` binding.** This worker reaches its DO classes through `ctx.exports` and
  declares none — `wrangler.jsonc` says so explicitly. What a new class needs is a **migration**,
  and it must be a **new tag**: the existing `migrations` array has a single `v0` entry listing four
  `new_sqlite_classes`, and a deployed tag must never be edited. So append
  `{ "tag": "v1", "new_sqlite_classes": ["WorkspaceLibraryDurableObject"] }`. Multi-tag histories
  are already normal here — other workers in the golden manifest carry two.
- That changes the release manifest, which copies the migration history verbatim
  (`manifest-lib.ts`) and is covered by a golden-file test. Regenerate with
  `UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts` and review the golden diff.
  (Note: the root `CLAUDE.md` cites `scripts/release-manifest.test.js` for this, which no longer
  exists — the path above is the real one. Worth fixing in `CLAUDE.md` separately.)
- The gatekeeper app bundle is generated into `src/generated/app.txt` by `build-app.mjs`; it is
  committed, so it must be rebuilt as part of the change.
- **No data migration.** Existing collections keep `visibility: "private" | "public"` and no
  `workspaceId`. Nothing is backfilled and no stored record changes shape.

## 11. Testing

- `WorkspaceLibraryDurableObject`: grant / revoke / sync / list.
- `workspaceEnabledCollections`: union and precedence (owned beats public beats granted; a
  collection both owned and granted resolves as owned).
- `ContextObserverTracker`: a granted collection skips verifier queries and never excludes an
  observer; the same collection after revocation *does* consult the verifier and *does* reject.
- Create/delete/propagate keep the two indexes consistent, including the rollback path when the
  second index write fails.
- `revoke()` clears grants — the §8 hole.
- The facet's inherited workspace id is not the account id (mirroring the scheduler's smoke check).
- `pnpm lint` (oxlint + recursive `tsc --noEmit`) and `pnpm build` for the touched packages.

## 12. File inventory

**`packages/gatekeeper-context`** (the bulk):
`src/context-types.ts`, `src/workspace-library.ts` (new), `src/context-api.ts`,
`src/context-collection.ts`, `src/library-read.ts`, `src/library-gatekeeper.ts`,
`src/context-observers.ts`, `src/collection-kv.ts`, `src/index.ts` (export the new DO),
`app/ContextLibraryPage.tsx`, `app/bridge.ts`, `wrangler.jsonc` (migration tag only),
`src/generated/app.txt` (regenerated).

**`packages/workshop-frontend`** (host picker only):
`src/SandboxedGatekeeperApp.tsx`, plus the picker modal component and its workspace-list source.

**`packages/workshop-shared`**: none. The read path rides on facet id inheritance (§4.4), and the
picker is a frontend host-bridge concern, so the kernel API is untouched.

**Docs**: `docs/observers.md` §9.2 (the Strategy C row).

## 13. Suggested sequencing

Grouped so the security-relevant gatekeeper internals can be reviewed apart from the UI, per the
`workshop-backend` guidance in `CLAUDE.md`.

1. Types + `WorkspaceLibraryDurableObject` (exported from `src/index.ts` beside the other three
   DOs) + the `v1` migration tag + manifest golden.
2. Write path: create / propagate / delete / revoke keeping both indexes consistent.
3. Read path: the resolver and all three facet call sites.
4. Observers: skip verifier queries for granted collections; update `docs/observers.md`.
5. Host bridge `pickWorkspace()` + the Workshop picker modal.
6. The app: third radio, dropdown, disabled-Create validation, settings-pane chip and revoke.

Steps 1–4 are shippable without 5–6: the tier exists and works, just with no way to create one from
the UI yet.
