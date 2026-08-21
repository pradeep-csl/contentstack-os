# Workspace Visibility for Context & Skills Collections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third visibility to Context Library collections — `workspace` — making a collection's documents and skills readable by exactly one workspace's agent, for everyone chatting there.

**Architecture:** The scope is a single field (`scopedToWorkspace`) on the existing owned-collection record in `UserLibraryDurableObject`. No new Durable Object: because the ambient Context capsule is minted from the workspace *owner's* account and only owners may scope, every scope relevant to a facet already lives in that facet's own account's library. The facet learns its workspace id from Cloudflare facet inheritance (`this.ctx.id.toString()` is the parent Overseer's id), so no `workshop-shared` change is needed. Observer verification is skipped for scoped collections because an observer of workspace W's facet is a W collaborator by construction.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, Cap'n Web RPC, vitest (two suites: Node and `@cloudflare/vitest-pool-workers`), React 19 + Kumo UI for both the gatekeeper app and the Workshop frontend.

**Spec:** [`docs/superpowers/specs/2026-08-21-workspace-context-visibility-design.md`](../specs/2026-08-21-workspace-context-visibility-design.md) — read it before starting. Every task cites the section it implements.

## Global Constraints

- **pnpm only.** Never `npm`. Commands run from the repo root unless stated.
- **No AI/LLM attribution anywhere**, including commit messages. No `Co-Authored-By`.
- **Never widen `EnabledCollectionInfo["source"]`** beyond `"private" | "public"`. The comparator at `ContextLibraryPage.tsx:987` (`a.source === "public" ? -1 : 1`) is valid for two values and becomes an asymmetric, order-undefined comparator with three. The new `workspaceId` field carries the extra bit instead. (Spec §6.3.)
- **Exclusive semantics.** A scoped collection is readable through *only* that workspace's agent — not the creator's other workspaces. It remains fully manageable by its owner. (Spec §4.1.)
- **Owner-only scoping.** Only a workspace's owner may scope a collection to it. Enforced as UX in the picker; security does not depend on it (Spec §7.1).
- **Cap:** `MAX_SCOPED_COLLECTIONS_PER_WORKSPACE = 50`. (Spec §6.4.)
- **Existing behavior must not change.** Records with `scopedToWorkspace` absent behave exactly as today.
- **Two test suites in `gatekeeper-context`:** `__tests__/*.test.ts` runs in Node (`vitest.config.ts`); `__tests__/*.workers.test.ts` runs in the Workers pool (`vitest.workers.config.ts`). A test touching a Durable Object **must** be `*.workers.test.ts`.
- **Logging** uses `@gadgets/backend-utils/logger` via the package's existing `obsContext`. Never log document bodies, tokens, or collection contents.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/gatekeeper-context/src/context-types.ts` | Visibility union, metadata/summary/owned-record fields, the cap, the visibility predicate, `ContextApi` signatures | 1, 2 |
| `packages/gatekeeper-context/src/user-library.ts` | Persist the scope; filter the agent-enabled set; enforce the cap | 1 |
| `packages/gatekeeper-context/src/collection-kv.ts` | Carry `workspaceId` through `metadataToSummary` | 1 |
| `packages/gatekeeper-context/src/context-collection.ts` | `clearWorkspaceScope()`; propagation carries the scope | 2 |
| `packages/gatekeeper-context/src/context-api.ts` | Create with a scope, read/revoke the scope, agent-vs-management listing split | 2, 3 |
| `packages/gatekeeper-context/src/library-read.ts` | Thread `workspaceId` into the enabled-set resolver | 3 |
| `packages/gatekeeper-context/src/library-gatekeeper.ts` | `#workspaceId()`; pass it at all three facet call sites; feed the tracker | 3, 4 |
| `packages/gatekeeper-context/src/context-observers.ts` | Skip verifier queries for scoped collections; reworded throw | 4 |
| `packages/gatekeeper-context/app/ContextLibraryPage.tsx` | Third radio, workspace dropdown, Create validation, three-valued Source/Access, list badge, revoke confirmation | 6 |
| `packages/gatekeeper-context/app/bridge.ts` | `useWorkspacePicker()` host-bridge hook | 6 |
| `packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx` | `pickWorkspace()` host method | 5 |
| `packages/workshop-frontend/src/GatekeeperWorkspacePicker.tsx` (new) | The Workshop-owned picker modal | 5 |
| `docs/observers.md` | Strategy C row gains the third access ground | 4 |

**Ship boundary:** Tasks 1–4 are independently shippable — the tier exists and works, with no UI to create one yet. Tasks 5–6 add the UI.

---

### Task 1: Scope field, enabled-set filter, and cap

Implements spec §5.1, §5.2, §6.1, §6.4.

**Files:**
- Modify: `packages/gatekeeper-context/src/context-types.ts`
- Modify: `packages/gatekeeper-context/src/user-library.ts`
- Modify: `packages/gatekeeper-context/src/collection-kv.ts`
- Test: `packages/gatekeeper-context/__tests__/enabled-collections.workers.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `type ContextCollectionVisibility = "public" | "private" | "workspace"`
  - `const MAX_SCOPED_COLLECTIONS_PER_WORKSPACE = 50`
  - `function isVisibleInWorkspace(scopedToWorkspace: string | undefined, workspaceId: string | undefined): boolean`
  - `ContextCollectionMetadata.workspaceId?: string`, `ContextCollectionSummary.workspaceId?: string`, `OwnedCollectionRecord.scopedToWorkspace?: string`, `EnabledCollectionInfo.workspaceId?: string`
  - `UserLibraryDurableObject.createOwnedCollection(id, title, description, icon?, scopedToWorkspace?): void` — throws `RangeError` past the cap
  - `UserLibraryDurableObject.getEnabledCollections(domain, workspaceId?): Promise<Map<string, ContextCollectionVisibility>>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/gatekeeper-context/__tests__/enabled-collections.workers.test.ts` (inside the existing `describe`):

```ts
  it("hides a scoped collection from other workspaces and from no-workspace callers", async () => {
    let accountId = crypto.randomUUID();
    let library = LIBRARIES.get(LIBRARIES.idFromName(domainName(DOMAIN, accountId)));
    await library.createOwnedCollection("plain", "Mine", "Private notes.");
    await library.createOwnedCollection("scoped", "Project", "Project notes.", undefined, "ws-1");

    let inScope = await library.getEnabledCollections(DOMAIN, "ws-1");
    expect(inScope.get("plain")).toBe("private");
    expect(inScope.get("scoped")).toBe("workspace");

    let otherWorkspace = await library.getEnabledCollections(DOMAIN, "ws-2");
    expect(otherWorkspace.get("plain")).toBe("private");
    expect(otherWorkspace.has("scoped")).toBe(false);

    let noWorkspace = await library.getEnabledCollections(DOMAIN);
    expect(noWorkspace.has("scoped")).toBe(false);
  });

  it("keeps a scope across a metadata refresh", async () => {
    let accountId = crypto.randomUUID();
    let library = LIBRARIES.get(LIBRARIES.idFromName(domainName(DOMAIN, accountId)));
    await library.createOwnedCollection("scoped", "Project", "Project notes.", undefined, "ws-1");

    await library.updateOwnedCollection("scoped", {
      id: "scoped",
      title: "Project renamed",
      description: "Project notes.",
      visibility: "workspace",
      workspaceId: "ws-1",
      documentCount: 2,
      lastUpdated: new Date(),
    });

    expect((await library.getEnabledCollections(DOMAIN, "ws-1")).has("scoped")).toBe(true);
    expect((await library.getEnabledCollections(DOMAIN, "ws-2")).has("scoped")).toBe(false);
    expect((await library.listOwnedCollections())[0].scopedToWorkspace).toBe("ws-1");
  });

  it("clears the scope when a refresh carries no workspace", async () => {
    let accountId = crypto.randomUUID();
    let library = LIBRARIES.get(LIBRARIES.idFromName(domainName(DOMAIN, accountId)));
    await library.createOwnedCollection("scoped", "Project", "Project notes.", undefined, "ws-1");

    await library.updateOwnedCollection("scoped", {
      id: "scoped",
      title: "Project",
      description: "Project notes.",
      visibility: "private",
      documentCount: 0,
      lastUpdated: new Date(),
    });

    expect((await library.getEnabledCollections(DOMAIN)).get("scoped")).toBe("private");
    expect((await library.listOwnedCollections())[0].scopedToWorkspace).toBeUndefined();
  });

  it("caps how many collections one workspace may hold", async () => {
    let accountId = crypto.randomUUID();
    let library = LIBRARIES.get(LIBRARIES.idFromName(domainName(DOMAIN, accountId)));
    for (let i = 0; i < MAX_SCOPED_COLLECTIONS_PER_WORKSPACE; i++) {
      await library.createOwnedCollection(`scoped-${i}`, `C${i}`, "", undefined, "ws-1");
    }
    // A different workspace is unaffected by another's budget.
    await library.createOwnedCollection("other-ws", "Other", "", undefined, "ws-2");

    await expect(library.createOwnedCollection("one-too-many", "No", "", undefined, "ws-1"))
      .rejects.toThrow(/too many/i);
  });
```

Add to that file's imports:

```ts
import { MAX_SCOPED_COLLECTIONS_PER_WORKSPACE } from "../src/context-types.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/gatekeeper-context && pnpm exec vitest run -c vitest.workers.config.ts enabled-collections
```

Expected: FAIL. The first new test fails because `createOwnedCollection` takes 4 arguments and `getEnabledCollections` takes 1; the cap test fails on the missing export.

- [ ] **Step 3: Add the types**

In `packages/gatekeeper-context/src/context-types.ts`, change the visibility union and its doc comment:

```ts
/**
 * Collection visibility within a sharing domain.
 *
 * - `private`: readable only through its owning account's agent sessions.
 * - `public`: readable by every account in the domain (admin-created).
 * - `workspace`: readable *only* through one workspace's agent — a narrowing of `private`, not
 *   private plus a grant. The owner still manages it everywhere; they just cannot read it through
 *   an agent outside that workspace.
 */
export type ContextCollectionVisibility = "public" | "private" | "workspace";
```

Add the cap and the predicate beside `MAX_DOCUMENT_BODY_BYTES`:

```ts
/**
 * How many collections one workspace may hold. Every search fans out across the whole enabled set
 * (see MAX_COLLECTION_FANOUT in library-read.ts), so an unbounded count would degrade every search
 * in that workspace.
 */
export const MAX_SCOPED_COLLECTIONS_PER_WORKSPACE = 50;

/**
 * Whether an owned collection is readable by an agent acting in `workspaceId`. An unscoped
 * collection is readable everywhere; a scoped one only in its own workspace. Passing no
 * `workspaceId` (a caller with no workspace context) excludes every scoped collection.
 */
export function isVisibleInWorkspace(
    scopedToWorkspace: string | undefined, workspaceId: string | undefined): boolean {
  return !scopedToWorkspace || scopedToWorkspace === workspaceId;
}
```

Add the fields. In `ContextCollectionMetadata`, after `visibility`:

```ts
  /**
   * The workspace this collection is scoped to. Set if and only if `visibility` is `"workspace"`.
   * Opaque here: it is the Overseer Durable Object id the Workshop calls a workspace id.
   */
  workspaceId?: string;
```

In `ContextCollectionSummary`, after `visibility`:

```ts
  /** Mirrors ContextCollectionMetadata.workspaceId, so the scope survives propagation. */
  workspaceId?: string;
```

In `OwnedCollectionRecord`, after `icon`:

```ts
  /** Set when this collection is scoped to a single workspace (visibility "workspace"). */
  scopedToWorkspace?: string;
```

In `EnabledCollectionInfo`, after `source`:

```ts
  /**
   * Set when this collection is scoped to one workspace. `source` deliberately stays
   * "private" | "public" — a scoped collection is always the viewer's own, and widening `source`
   * would break the two-valued comparator in the management UI's collection sort.
   */
  workspaceId?: string;
```

- [ ] **Step 4: Carry the scope through the summary**

In `packages/gatekeeper-context/src/collection-kv.ts`, add one line to `metadataToSummary`'s returned object, after `visibility`:

```ts
    workspaceId: metadata.workspaceId,
```

- [ ] **Step 5: Implement the user-library changes**

In `packages/gatekeeper-context/src/user-library.ts`, extend the stored record:

```ts
type OwnedRecord = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  // Absent on every record written before workspace visibility existed, which `isVisibleInWorkspace`
  // reads as "enabled everywhere" — so old collections keep behaving exactly as they did.
  scopedToWorkspace?: string;
  lastUpdated: Date;
};
```

Replace `createOwnedCollection`:

```ts
  createOwnedCollection(
      id: string, title: string, description: string, icon?: string,
      scopedToWorkspace?: string): void {
    if (scopedToWorkspace) this.#assertScopeBudget(scopedToWorkspace);
    this.storage.ownedCollections.put({
      id, title, description, icon, scopedToWorkspace, lastUpdated: new Date(),
    });
  }

  // Bounds one workspace's enabled set; see MAX_SCOPED_COLLECTIONS_PER_WORKSPACE.
  #assertScopeBudget(workspaceId: string): void {
    let count = 0;
    for (let record of this.storage.ownedCollections.list()) {
      if (record.scopedToWorkspace === workspaceId) count++;
    }
    if (count >= MAX_SCOPED_COLLECTIONS_PER_WORKSPACE) {
      throw new RangeError(
        `This workspace already has too many Context collections ` +
        `(limit ${MAX_SCOPED_COLLECTIONS_PER_WORKSPACE}).`);
    }
  }
```

Make `updateOwnedCollection` persist the scope — the summary is the source of truth, so an absent
`workspaceId` clears it:

```ts
  /** Refresh the denormalized owned record, including its workspace scope. */
  updateOwnedCollection(id: string, summary: ContextCollectionSummary): void {
    let record = this.storage.ownedCollections.get(id);
    if (record) {
      record.title = summary.title;
      record.description = summary.description;
      record.icon = summary.icon;
      // Carried explicitly: this method rebuilds the record from the summary, so omitting it would
      // silently drop the scope on the next metadata edit.
      record.scopedToWorkspace = summary.workspaceId;
      record.lastUpdated = summary.lastUpdated;
      this.storage.ownedCollections.put(record);
    }
  }
```

Include the field in `listOwnedCollections`'s mapped object, after `icon: r.icon,`:

```ts
      scopedToWorkspace: r.scopedToWorkspace,
```

Replace `getEnabledCollections`:

```ts
  /**
   * Enabled collection visibility for the agent read path, as seen from `workspaceId`. Owned wins on
   * overlap so private is never downgraded to public. Collections scoped to a *different* workspace
   * are excluded, which is what makes workspace visibility exclusive rather than additive; passing
   * no `workspaceId` excludes every scoped collection.
   */
  async getEnabledCollections(
      domain: string, workspaceId?: string): Promise<Map<string, ContextCollectionVisibility>> {
    let result = new Map<string, ContextCollectionVisibility>();
    for (let record of this.storage.ownedCollections.list()) {
      if (!isVisibleInWorkspace(record.scopedToWorkspace, workspaceId)) continue;
      result.set(record.id, record.scopedToWorkspace ? "workspace" : "private");
    }
    for (let entry of await listPublicCollectionsFromKv(this.env, domain)) {
      if (!result.has(entry.id)) result.set(entry.id, "public");
    }
    return result;
  }
```

Update that file's import from `./context-types.js` to add `isVisibleInWorkspace` and
`MAX_SCOPED_COLLECTIONS_PER_WORKSPACE`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd packages/gatekeeper-context && pnpm exec vitest run -c vitest.workers.config.ts enabled-collections
```

Expected: PASS, including the pre-existing "resolves the account's own collections plus every public one" test — it calls `getEnabledCollections(DOMAIN)` with no workspace and must still see both unscoped collections.

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @gadgets/gatekeeper-context build
```

Expected: no errors. If `tsc` flags an unhandled `"workspace"` case anywhere, that site belongs to a later task — record it and leave the behavior unchanged for now (`"workspace"` must follow the same branch as `"private"`).

- [ ] **Step 8: Commit**

```bash
git add packages/gatekeeper-context/src/context-types.ts \
        packages/gatekeeper-context/src/user-library.ts \
        packages/gatekeeper-context/src/collection-kv.ts \
        packages/gatekeeper-context/__tests__/enabled-collections.workers.test.ts
git commit -m "feat(context): scope owned collections to a single workspace"
```

---

### Task 2: Create with a scope, and revoke it

Implements spec §5.2, §8.

**Files:**
- Modify: `packages/gatekeeper-context/src/context-types.ts` (the `ContextApi` interface)
- Modify: `packages/gatekeeper-context/src/context-api.ts`
- Modify: `packages/gatekeeper-context/src/context-collection.ts`
- Test: `packages/gatekeeper-context/__tests__/workspace-scope.workers.test.ts` (create)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces:
  - `ContextApi.createContextCollection(title, description, visibility, icon?, source?, workspaceId?)`
  - `ContextApi.getContextCollectionWorkspace(collectionId): Promise<string | null>`
  - `ContextApi.revokeContextCollectionWorkspace(collectionId): Promise<void>`
  - `ContextCollectionDurableObject.clearWorkspaceScope(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `packages/gatekeeper-context/__tests__/workspace-scope.workers.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ContextApiImpl } from "../src/context-api.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import { domainName } from "../src/domain.js";

const DOMAIN = "scope-domain";
const WORKSPACE = "w".repeat(64);
const OTHER_WORKSPACE = "x".repeat(64);

function api(accountId: string, isAdmin = false) {
  return new ContextApiImpl(
    env as unknown as Cloudflare.Env,
    DOMAIN,
    accountId,
    isAdmin,
    env.CONTEXT_COLLECTIONS_TEST as DurableObjectNamespace<ContextCollectionDurableObject>,
    env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>,
    env.REGISTRIES_TEST as DurableObjectNamespace<LibraryRegistryDurableObject>,
  );
}

function library(accountId: string) {
  let libraries = env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>;
  return libraries.get(libraries.idFromName(domainName(DOMAIN, accountId)));
}

describe("workspace-scoped collections", () => {
  it("needs a workspace id, and refuses one for other visibilities", async () => {
    await expect(api("user-1").createContextCollection("P", "Project notes.", "workspace"))
      .rejects.toThrow(/workspace/i);
    await expect(
      api("user-1").createContextCollection("P", "Project notes.", "private", undefined, "web", WORKSPACE),
    ).rejects.toThrow(/only workspace-scoped/i);
  });

  it("creates one for a non-admin, owned by its creator", async () => {
    let user = api("user-2");
    let meta = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);

    expect(meta.visibility).toBe("workspace");
    expect(meta.workspaceId).toBe(WORKSPACE);
    // Owned, so the creator can still write to it.
    expect(await user.canWriteContextCollection(meta.id)).toBe(true);
    await user.putContextDocument(meta.id, "notes.md", { description: "Notes.", body: "# Notes" });
    expect((await user.listContextDocuments(meta.id))).toHaveLength(1);
  });

  it("is enabled only in its own workspace", async () => {
    let meta = await api("user-3").createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);

    expect((await library("user-3").getEnabledCollections(DOMAIN, WORKSPACE)).get(meta.id))
      .toBe("workspace");
    expect((await library("user-3").getEnabledCollections(DOMAIN, OTHER_WORKSPACE)).has(meta.id))
      .toBe(false);
  });

  it("reports and revokes the scope, returning the collection to private", async () => {
    let user = api("user-4");
    let meta = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);
    expect(await user.getContextCollectionWorkspace(meta.id)).toBe(WORKSPACE);

    await user.revokeContextCollectionWorkspace(meta.id);

    expect(await user.getContextCollectionWorkspace(meta.id)).toBeNull();
    let refreshed = await user.getContextCollectionMetadata(meta.id);
    expect(refreshed?.visibility).toBe("private");
    expect(refreshed?.workspaceId).toBeUndefined();
    // Private again means enabled everywhere, including with no workspace context.
    expect((await library("user-4").getEnabledCollections(DOMAIN)).get(meta.id)).toBe("private");
  });

  it("refuses to revoke a collection the caller does not own", async () => {
    let meta = await api("user-5").createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);
    await expect(api("stranger").revokeContextCollectionWorkspace(meta.id))
      .rejects.toThrow(/don't have access/);
  });

  it("keeps the management listing showing the creator's scoped collections", async () => {
    let user = api("user-6");
    let meta = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);

    let listed = await user.listEnabledContextCollections();
    let entry = listed.find(collection => collection.id === meta.id);
    expect(entry?.workspaceId).toBe(WORKSPACE);
    // Never widened: the management UI's sort comparator depends on `source` being two-valued.
    expect(entry?.source).toBe("private");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/gatekeeper-context && pnpm exec vitest run -c vitest.workers.config.ts workspace-scope
```

Expected: FAIL — `createContextCollection` takes no `workspaceId`, and `getContextCollectionWorkspace` / `revokeContextCollectionWorkspace` do not exist.

- [ ] **Step 3: Declare the API**

In `packages/gatekeeper-context/src/context-types.ts`, replace the `createContextCollection`
declaration in `interface ContextApi` and add the two new methods next to it:

```ts
  /**
   * `workspaceId` is required when `visibility` is "workspace" and rejected otherwise. Creating a
   * "public" collection requires admin; "workspace" does not — the Workshop only offers workspaces
   * the user owns, and a workspace id the creator does not own yields a collection no agent reads.
   */
  createContextCollection(
    title: string, description: string, visibility: ContextCollectionVisibility, icon?: string,
    source?: ContextCollectionContent["source"], workspaceId?: string,
  ): Promise<ContextCollectionMetadata>;

  /**
   * The workspace this collection is scoped to, or null if it is not workspace-scoped. Readable by
   * the owner (and, for a public collection, anyone) — an admin who does not own a workspace-scoped
   * collection cannot read it, the same position they are in for private collections.
   */
  getContextCollectionWorkspace(collectionId: string): Promise<string | null>;

  /**
   * Drop the workspace scope, returning the collection to private.
   *
   * NOTE: the workspace's gatekeeper facet keeps its record that this collection's data was
   * observed, so until the collection is scoped to that workspace again, adding a *new*
   * collaborator to it will fail. Re-scoping restores it. Callers should confirm before invoking.
   */
  revokeContextCollectionWorkspace(collectionId: string): Promise<void>;
```

- [ ] **Step 4: Implement `clearWorkspaceScope` on the collection**

In `packages/gatekeeper-context/src/context-collection.ts`, add this method beside
`updateMetadata` (it reuses the existing `#propagate()`, which already routes non-public
collections to the owner library):

```ts
  /**
   * Return a workspace-scoped collection to private. Propagation carries the cleared `workspaceId`
   * into the owner-library record, which is what actually re-enables the collection everywhere.
   */
  async clearWorkspaceScope(): Promise<void> {
    let meta = this.storage.metadata.get();
    if (meta.visibility !== "workspace") return;
    this.storage.metadata.put({
      ...meta, visibility: "private", workspaceId: undefined, lastUpdated: new Date(),
    });
    await this.#propagate();
  }
```

- [ ] **Step 5: Implement the API**

In `packages/gatekeeper-context/src/context-api.ts`, replace `createContextCollection`'s signature
and its validation/index-write sections:

```ts
  async createContextCollection(
    title: string,
    description: string,
    visibility: ContextCollectionVisibility,
    icon?: string,
    source: ContextCollectionContent["source"] = "web",
    workspaceId?: string,
  ): Promise<ContextCollectionMetadata> {
    if (visibility === "public") this.#assertAdmin();
    if (visibility === "workspace") {
      if (!workspaceId) throw new Error("A workspace must be chosen for a workspace collection.");
    } else if (workspaceId) {
      throw new Error("A workspace may only be given for workspace-scoped collections.");
    }
    if (source !== "web" && source !== "git" && source !== "push") {
      throw new Error(`Unsupported collection source: ${source}`);
    }
    if (source === "git" && !this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }

    let id = crypto.randomUUID();
    let metadata: ContextCollectionMetadata = {
      id,
      icon,
      title,
      description,
      visibility,
      workspaceId,
      created: new Date(),
      lastUpdated: new Date(),
      documentCount: 0,
      content: source === "git"
        ? { source, remote: "", branch: DEFAULT_GIT_BRANCH, lastRefreshedAt: new Date() }
        : { source },
    };

    // Initialize before indexing; if this fails, nothing is reachable yet. A workspace collection
    // has a creator-owner exactly like a private one — that is what keeps it writable by them.
    metadata = await this.#collection(id).initialize(
      metadata, this.domain, visibility === "public" ? "" : this.accountId);

    // Public collections live in the domain registry; private and workspace-scoped ones live in the
    // owner's library, the latter carrying their scope.
    try {
      if (visibility === "public") {
        await this.#registry().addPublic(this.domain, metadataToSummary(metadata));
      } else {
        await this.#userLib().createOwnedCollection(id, title, description, icon, workspaceId);
      }
    } catch (err) {
      // Indexing failed; delete the now-unreachable collection.
      await this.#collection(id).deleteSelf().catch(() => {});
      throw err;
    }
    return metadata;
  }
```

Add the two new methods beside `deleteContextCollection`:

```ts
  async getContextCollectionWorkspace(collectionId: string): Promise<string | null> {
    await this.#assertCanRead(collectionId);
    return (await this.#collection(collectionId).getMetadata()).workspaceId ?? null;
  }

  async revokeContextCollectionWorkspace(collectionId: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).clearWorkspaceScope();
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd packages/gatekeeper-context && pnpm exec vitest run -c vitest.workers.config.ts workspace-scope
```

Expected: PASS, all six.

- [ ] **Step 7: Run the whole package suite and typecheck**

```bash
cd packages/gatekeeper-context && pnpm run test:run
pnpm --filter @gadgets/gatekeeper-context build
```

Expected: PASS. `admin-gating.workers.test.ts` must still pass unchanged — it calls
`createContextCollection` with five positional arguments, which the new sixth parameter keeps
compatible.

- [ ] **Step 8: Commit**

```bash
git add packages/gatekeeper-context/src/context-types.ts \
        packages/gatekeeper-context/src/context-api.ts \
        packages/gatekeeper-context/src/context-collection.ts \
        packages/gatekeeper-context/__tests__/workspace-scope.workers.test.ts
git commit -m "feat(context): create and revoke workspace-scoped collections"
```

---

### Task 3: Thread the workspace id through the read path

Implements spec §6.1, §6.2, §4.5.

**Files:**
- Modify: `packages/gatekeeper-context/src/library-read.ts`
- Modify: `packages/gatekeeper-context/src/context-api.ts`
- Modify: `packages/gatekeeper-context/src/library-gatekeeper.ts`
- Test: `packages/gatekeeper-context/__tests__/workspace-scope.workers.test.ts`

**Interfaces:**
- Consumes: `isVisibleInWorkspace`, `getEnabledCollections(domain, workspaceId?)` (Task 1); `createContextCollection(..., workspaceId?)` (Task 2).
- Produces:
  - `accountEnabledCollections(userLibraries, domain, accountId, workspaceId?): ResolveEnabledCollections`
  - `loadAgentContextCollections(env, domain, userLibrary, workspaceId): Promise<EnabledCollectionInfo[]>`
  - `ContextGatekeeper.#workspaceId(): string`

- [ ] **Step 1: Write the failing tests**

Append to `packages/gatekeeper-context/__tests__/workspace-scope.workers.test.ts`:

```ts
describe("agent-facing collection listing", () => {
  it("filters scoped collections by workspace, and never filters the management listing", async () => {
    let user = api("user-7");
    let scoped = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);
    let plain = await user.createContextCollection("Mine", "Personal notes.", "private");

    let inScope = await loadAgentContextCollections(
      env as unknown as Cloudflare.Env, DOMAIN, library("user-7"), WORKSPACE);
    expect(inScope.map(entry => entry.id).sort()).toEqual([plain.id, scoped.id].sort());

    let elsewhere = await loadAgentContextCollections(
      env as unknown as Cloudflare.Env, DOMAIN, library("user-7"), OTHER_WORKSPACE);
    expect(elsewhere.map(entry => entry.id)).toEqual([plain.id]);

    // The management listing is deliberately unfiltered: hiding the creator's own scoped
    // collection from their own library page would be a bug, not exclusivity.
    let managed = await loadEnabledContextCollections(
      env as unknown as Cloudflare.Env, DOMAIN, library("user-7"));
    expect(managed.map(entry => entry.id).sort()).toEqual([plain.id, scoped.id].sort());
  });

  it("pins a read session to the collections enabled in its workspace", async () => {
    let user = api("user-8");
    let scoped = await user.createContextCollection(
      "Project", "Project notes.", "workspace", undefined, "web", WORKSPACE);
    await user.putContextDocument(scoped.id, "notes.md", {
      description: "Notes.", body: "# Secret project notes",
    });

    let libraries = env.USER_LIBRARIES_TEST as DurableObjectNamespace<UserLibraryDurableObject>;
    let inScope = await accountEnabledCollections(libraries, DOMAIN, "user-8", WORKSPACE)();
    expect(inScope.has(scoped.id)).toBe(true);
    let elsewhere = await accountEnabledCollections(libraries, DOMAIN, "user-8", OTHER_WORKSPACE)();
    expect(elsewhere.has(scoped.id)).toBe(false);
  });
});
```

Add to that file's imports:

```ts
import { accountEnabledCollections } from "../src/library-read.js";
import { loadAgentContextCollections, loadEnabledContextCollections } from "../src/context-api.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/gatekeeper-context && pnpm exec vitest run -c vitest.workers.config.ts workspace-scope
```

Expected: FAIL — `loadAgentContextCollections` is not exported and `accountEnabledCollections` takes three arguments.

- [ ] **Step 3: Thread the argument through the resolver**

In `packages/gatekeeper-context/src/library-read.ts`, replace `accountEnabledCollections`:

```ts
/**
 * Default resolution: the account's own collections plus every public collection in the domain.
 * `workspaceId` is the workspace the session acts in; collections scoped to a different workspace
 * are excluded, which is what makes workspace visibility exclusive.
 */
export function accountEnabledCollections(
    userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    domain: string,
    accountId: string,
    workspaceId?: string): ResolveEnabledCollections {
  return () => userLibraries.get(userLibraries.idFromName(domainName(domain, accountId)))
      .getEnabledCollections(domain, workspaceId);
}
```

- [ ] **Step 4: Add the agent-facing listing**

In `packages/gatekeeper-context/src/context-api.ts`, add `workspaceId` to the entry built from each
owned record inside `loadEnabledContextCollections` (after `source: "private",`):

```ts
      workspaceId: collection.scopedToWorkspace,
```

Then add this function directly beneath `loadEnabledContextCollections`, and expand that function's
own doc comment to say it is the *unfiltered management* listing:

```ts
/**
 * The collections an agent acting in `workspaceId` may use: the management listing minus every
 * collection scoped to a different workspace. Public collections carry no scope and always pass.
 */
export async function loadAgentContextCollections(
    env: Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">,
    domain: string,
    userLibrary: DurableObjectStub<UserLibraryDurableObject>,
    workspaceId: string): Promise<EnabledCollectionInfo[]> {
  return (await loadEnabledContextCollections(env, domain, userLibrary))
      .filter(collection => isVisibleInWorkspace(collection.workspaceId, workspaceId));
}
```

Add `isVisibleInWorkspace` to that file's import from `./context-types.js`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd packages/gatekeeper-context && pnpm exec vitest run -c vitest.workers.config.ts workspace-scope
```

Expected: PASS.

- [ ] **Step 6: Use the workspace id at all three facet call sites**

In `packages/gatekeeper-context/src/library-gatekeeper.ts`, add this to `ContextGatekeeper` beside
its other private helpers:

```ts
  /**
   * The workspace this facet serves. Gatekeepers are installed as Facets under the workspace's
   * Overseer (see overseer.ts `ctx.facets.get("gatekeeper<id>")`), and a facet inherits its
   * parent's Durable Object id — which is exactly the id the Workshop calls a workspace id
   * (workspaces are created with `newUniqueId().toString()`). Verified by
   * gatekeeper-scheduler's __tests__/scheduler-scope.test.ts.
   */
  #workspaceId(): string {
    let workspaceId = this.ctx.id.toString();
    // Smoke check only, mirroring gatekeeper-scheduler: proves we did not get the account scope.
    if (!workspaceId || workspaceId === this.ctx.props.accountId) {
      throw new Error("Invalid inherited Context workspace scope.");
    }
    return workspaceId;
  }
```

Then make all three read paths pass it. In `#newReadSession`:

```ts
        accountEnabledCollections(
          this.#userLibraries(), this.ctx.props.sharingDomain, this.ctx.props.accountId,
          this.#workspaceId()),
```

In `#listSlashCommands`, replace the `loadEnabledContextCollections(...)` call:

```ts
    let collections = (await loadAgentContextCollections(
          this.env, domain, userLibrary, this.#workspaceId()))
        .toSorted((left, right) =>
          left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
```

In `getAgentCatalog`, replace its `loadEnabledContextCollections(...)` call:

```ts
    let collections = await loadAgentContextCollections(
      this.env, domain, userLibrary, this.#workspaceId());
```

Update the import from `./context-api.js` to bring in `loadAgentContextCollections`. If
`loadEnabledContextCollections` is no longer referenced in this file, drop it from the import —
unused imports are a lint error.

**Coverage note.** `#workspaceId()` itself is not unit-tested here. Exercising it needs a test
parent Durable Object that opens the gatekeeper as a facet, which this package has no harness for
(`gatekeeper-scheduler` built one — see its `__tests__/worker.ts` and `scheduler-scope.test.ts`).
The inheritance behavior is already covered by that package's test, and the smoke check fails loudly
if it ever regresses. Building the equivalent harness here is worthwhile but out of scope; do not
silently skip it — Step 9 of Task 6 exercises the path manually instead.

- [ ] **Step 7: Verify the whole package**

```bash
cd packages/gatekeeper-context && pnpm run test:run
pnpm --filter @gadgets/gatekeeper-context build
```

Expected: PASS with no type errors. All three call sites now pass a workspace id; the management
listing (`ContextApi.listEnabledContextCollections`) still calls the unfiltered function.

- [ ] **Step 8: Commit**

```bash
git add packages/gatekeeper-context/src/library-read.ts \
        packages/gatekeeper-context/src/context-api.ts \
        packages/gatekeeper-context/src/library-gatekeeper.ts \
        packages/gatekeeper-context/__tests__/workspace-scope.workers.test.ts
git commit -m "feat(context): pin agent sessions, catalogs and skills to their workspace"
```

---

### Task 4: Skip observer verification for scoped collections

Implements spec §7, §7.2.

**Files:**
- Modify: `packages/gatekeeper-context/src/context-observers.ts`
- Modify: `packages/gatekeeper-context/src/library-gatekeeper.ts`
- Modify: `docs/observers.md`
- Test: `packages/gatekeeper-context/__tests__/context-observers.test.ts`

**Interfaces:**
- Consumes: `loadAgentContextCollections` (Task 3), `#workspaceId()` (Task 3).
- Produces: `new ContextObserverTracker(kv, sharingDomain, resolveScoped?)` where
  `resolveScoped: () => Promise<Set<string>>` — omitted means no scoped collections, so all six
  existing tests keep passing unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gatekeeper-context/__tests__/context-observers.test.ts`, inside the existing
`describe`:

```ts
  it("never asks a verifier about a collection scoped to this workspace", async () => {
    let scoped = new Set(["project"]);
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example", async () => scoped);
    let denied = verifier([]);
    await tracker.addObserver("collaborator", denied.api);

    // A scoped collection is accessible to every observer of this facet by construction: an
    // observer *is* a collaborator on this workspace.
    expect(await observe(tracker, ["project"])).toBeUndefined();
    expect(denied.calls).toEqual([]);
  });

  it("admits an observer even when a scoped collection was already read", async () => {
    let scoped = new Set(["project"]);
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example", async () => scoped);
    await observe(tracker, ["project"]);

    let denied = verifier([]);
    await expect(tracker.addObserver("collaborator", denied.api)).resolves.toBeUndefined();
    expect(denied.calls).toEqual([]);
  });

  it("consults the verifier again once the scope is revoked, and stops when it is restored", async () => {
    let scoped = new Set(["project"]);
    let kv = makeKv();
    let tracker = new ContextObserverTracker(kv, "workshop.example", async () => scoped);
    await observe(tracker, ["project"]);

    // Revoked: the workspace's log still holds the data, so a new collaborator must be checked.
    scoped.delete("project");
    let denied = verifier([]);
    await expect(tracker.addObserver("collaborator", denied.api)).rejects.toThrow(
      /no longer shared with this workspace|does not have access/,
    );
    expect(denied.calls.map(call => call.collectionId)).toEqual(["project"]);

    // Re-scoped: admission works again. This is the documented remedy.
    scoped.add("project");
    let second = verifier([]);
    await expect(tracker.addObserver("collaborator", second.api)).resolves.toBeUndefined();
    expect(second.calls).toEqual([]);
  });

  it("still checks unscoped collections when a scope resolver is present", async () => {
    let tracker = new ContextObserverTracker(
      makeKv(), "workshop.example", async () => new Set(["project"]));
    await observe(tracker, ["project", "shared"]);

    let limited = verifier([]);
    await expect(tracker.addObserver("collaborator", limited.api)).rejects.toThrow();
    expect(limited.calls.map(call => call.collectionId)).toEqual(["shared"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/gatekeeper-context && pnpm exec vitest run context-observers
```

Expected: FAIL — the constructor takes two arguments, so the third is a type error and the scoped
collections are still sent to the verifier.

- [ ] **Step 3: Implement the tracker change**

In `packages/gatekeeper-context/src/context-observers.ts`, replace the class's constructor and add
the filter. The scoped set is resolved lazily and memoized per tracker instance (the facet builds a
fresh tracker per operation, so each operation sees a current view):

```ts
/** Resolves the collections scoped to this facet's own workspace. */
export type ResolveScopedCollections = () => Promise<Set<string>>;

/**
 * Strategy C observer state for the broad Context Library singleton. Collections are the data sets:
 * public collections are domain-wide, each private collection belongs to one account, and a
 * workspace-scoped collection belongs to this facet's workspace.
 *
 * Workspace-scoped collections are accessible to every observer *structurally* — an observer is a
 * collaborator on this workspace by construction — so they are never sent to a verifier. This is a
 * third ground for access alongside "public in the domain" and "privately owned by the observer"
 * (see docs/observers.md §9.2), and it is what lets a workspace share curated knowledge and add
 * collaborators at the same time.
 */
export class ContextObserverTracker {
  constructor(
    private kv: ObserverKv,
    private sharingDomain: string,
    private resolveScoped?: ResolveScopedCollections,
  ) {}

  #scopedPromise?: Promise<Set<string>>;

  // Memoized per tracker instance. A tracker is built per operation, so a later operation sees any
  // revocation that happened in between.
  #scoped(): Promise<Set<string>> {
    return (this.#scopedPromise ??= this.resolveScoped?.() ?? Promise.resolve(new Set()));
  }

  // Collections a verifier must actually be asked about: everything not scoped to this workspace.
  async #needingVerification(collectionIds: string[]): Promise<string[]> {
    if (!this.resolveScoped) return collectionIds;
    let scoped = await this.#scoped();
    return collectionIds.filter(collectionId => !scoped.has(collectionId));
  }
```

In `addObserver`, filter before querying — but short-circuit *before* resolving the scoped set, so a
workspace whose agent has read nothing still admits collaborators without any Durable Object read
(the common case, and one that previously could not fail on a library read at all). Replace its
body:

```ts
  async addObserver(id: string, verifier: Fetcher<ContextVerifierApi>): Promise<void> {
    let checked = new Set<string>();
    while (true) {
      let tracked = this.#listTrackedCollections()
          .filter(collectionId => !checked.has(collectionId));
      // Nothing observed yet: admit without resolving scope. Keeps the empty case free.
      if (tracked.length === 0) {
        this.kv.put(this.#observerKey(id), verifier);
        return;
      }
      let collections = await this.#needingVerification(tracked);
      if (collections.length === 0) {
        this.kv.put(this.#observerKey(id), verifier);
        return;
      }
      let access = await Promise.all(collections.map(
        collectionId => verifier.hasCollectionAccess(this.sharingDomain, collectionId),
      ));
      if (access.some(hasAccess => !hasAccess)) {
        throw new Error(
          "This workspace has read a Context collection that this collaborator cannot access — " +
          "either a private collection of another user, or one no longer shared with this " +
          "workspace. Re-sharing that collection with this workspace restores collaborator access.",
        );
      }
      for (let collectionId of collections) checked.add(collectionId);
    }
  }
```

In `prepareObservation`, filter the ids each observer is asked about — again short-circuiting before
the scope resolution, because **this method runs on every single agent read** (search, list and
read all call it). An unshared workspace has no observers, and must not pay anything. Replace the
`observerAccess` computation:

```ts
    let observers = [...this.#listObservers()];
    // No observers (the common single-user case) means nothing to exclude and no scope to resolve.
    if (observers.length === 0) {
      return {
        pendingCollections,
        commit: () => this.commitObservation(pendingCollections),
      };
    }
    let toVerify = await this.#needingVerification(pendingCollections);
    let observerAccess = await Promise.all(observers.map(async ([id, verifier]) => {
      let access = await Promise.all(toVerify.map(
        collectionId => verifier.hasCollectionAccess(this.sharingDomain, collectionId),
      ));
      return [id, access.every(hasAccess => hasAccess)] as const;
    }));
```

Leave `pendingCollections` and `commit()` alone: scoped reads are still **recorded** as observed,
because the workspace's chat log holds that data and a collaborator added later can read the log.

Note the loop in `addObserver` re-reads the tracked list each pass, so a collection that arrives
while an admission awaits is still checked — the behavior
`"rechecks collections added while observer admission is awaiting"` covers.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/gatekeeper-context && pnpm exec vitest run context-observers
```

Expected: PASS — the four new tests **and** all six pre-existing ones, which construct the tracker
with two arguments and must be untouched.

- [ ] **Step 5: Feed the tracker its scoped set — reusing data already resolved**

The naive wiring (have the tracker read the owner's library itself) would add a Durable Object read
to **every agent search, list and read**, since `prepareObservation` runs on each one. Avoid it: the
callers that need a scoped set have already resolved one. `getEnabledCollections` labels this
workspace's scoped collections `"workspace"` — a value nothing read until now — and
`loadAgentContextCollections` returns `workspaceId` per entry. So let callers supply the derivation
and keep the library read as the fallback for the one path with nothing at hand.

In `packages/gatekeeper-context/src/library-gatekeeper.ts`, replace `ContextGatekeeper.#observers()`:

```ts
  /**
   * The observer tracker for this facet. Callers that have already resolved this workspace's
   * enabled set pass a derivation of it, so the read hot path costs no extra Durable Object reads;
   * `addObserver`/`removeObserver`, which have nothing at hand, fall back to reading the library.
   */
  #observers(resolveScoped?: ResolveScopedCollections) {
    return new ContextObserverTracker(
      this.ctx.storage.kv, this.ctx.props.sharingDomain,
      resolveScoped ?? (() => this.#scopedCollectionIds()));
  }

  // Fallback: the collections scoped to this facet's workspace, straight from the owner's library —
  // the same source the enabled set uses, so the two can never disagree.
  async #scopedCollectionIds(): Promise<Set<string>> {
    let domain = this.ctx.props.sharingDomain;
    let userLibrary = this.#userLibraries().get(
      this.#userLibraries().idFromName(domainName(domain, this.ctx.props.accountId)));
    let workspaceId = this.#workspaceId();
    return new Set(
      (await userLibrary.listOwnedCollections())
        .filter(collection => collection.scopedToWorkspace === workspaceId)
        .map(collection => collection.id));
  }
```

Then share one resolution between the session and its tracker. Replace `#newReadSession`'s body
(keeping its existing `dup()` / dispose-on-throw structure exactly):

```ts
  #newReadSession(authorizer: NativeRpcStub<ObservationAuthorizer>): LibraryReadSession {
    // The read session uses this authorizer after startSession() returns, so it owns a duplicate.
    let ownedAuthorizer = authorizer.dup();
    try {
      let resolve = accountEnabledCollections(
        this.#userLibraries(), this.ctx.props.sharingDomain, this.ctx.props.accountId,
        this.#workspaceId());
      // Resolved at most once and shared: the tracker's scoped set is a projection of the very map
      // the session reads, so no second round trip and no chance of the two disagreeing.
      let enabledOnce: Promise<Map<string, ContextCollectionVisibility>> | undefined;
      let enabled = () => (enabledOnce ??= resolve());
      let observers = this.#observers(async () => new Set(
        [...await enabled()]
          .filter(([, visibility]) => visibility === "workspace")
          .map(([collectionId]) => collectionId)));
      return new LibraryReadSession(
        this.#collections(), enabled, this.ctx.props.sharingDomain, ownedAuthorizer,
        collectionIds => observers.prepareObservation(collectionIds));
    } catch (err) {
      ownedAuthorizer[Symbol.dispose]?.();
      throw err;
    }
  }
```

In `getAgentCatalog`, the entries are already in hand, so derive from them. Replace its
`this.#observers().prepareObservation(collectionIds)` call:

```ts
      let workspaceId = this.#workspaceId();
      let check = await this.#observers(async () => new Set(
        collections.filter(collection => collection.workspaceId === workspaceId)
          .map(collection => collection.id))).prepareObservation(collectionIds);
```

Add `ContextCollectionVisibility` to the import from `./context-types.js` and
`ResolveScopedCollections` to the import from `./context-observers.js`.

- [ ] **Step 6: Record the third access ground in the observer doc**

In `docs/observers.md` §9.2, replace the `context` row:

```markdown
| **context** | Context Library singleton | **C** | Track observed collections; verify each is public in the sharing domain, privately owned by the observer's Context account, or scoped to *this* workspace — the last needs no verifier, since an observer is a collaborator on this workspace by construction. |
```

- [ ] **Step 7: Verify the whole package**

```bash
cd packages/gatekeeper-context && pnpm run test:run
pnpm --filter @gadgets/gatekeeper-context build
```

Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/gatekeeper-context/src/context-observers.ts \
        packages/gatekeeper-context/src/library-gatekeeper.ts \
        packages/gatekeeper-context/__tests__/context-observers.test.ts \
        docs/observers.md
git commit -m "feat(context): let workspace-scoped collections keep a workspace shareable"
```

**Ship boundary.** The tier is now complete and correct end to end; only the create UI is missing.
Run `pnpm lint` before continuing.

---

### Task 5: The Workshop's workspace picker

Implements spec §4.6, §9.1.

**Files:**
- Create: `packages/workshop-frontend/src/GatekeeperWorkspacePicker.tsx`
- Modify: `packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx`
- Test: `packages/workshop-frontend/src/SandboxedGatekeeperApp.test.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1–4 (pure frontend).
- Produces: host method `pickWorkspace(): Promise<{ id: string; title: string } | null>` on the
  app-facing host capability.

- [ ] **Step 1: Write the failing test**

Read the existing test file first. Three constraints in it that are easy to break:

- The whole suite is a **single long `it(...)`** that renders the router, dispatches the `handshake`
  message and assigns the module-scoped `host` at roughly line 103. There is no `connectHost()`
  helper, so the new assertions go **at the end of that same `it`**, where `host` is already
  connected.
- `"b".repeat(64)` is already used as a deliberately *unknown* workspace id, asserted to resolve to
  `null`. **Do not reuse it** for a real workspace. Use `"c".repeat(64)`.
- That test drives `listGadgets` with chained `mockResolvedValueOnce(...)` and asserts
  `expect(listGadgets).toHaveBeenCalledTimes(1)` then `(2)`. **Leave the shared default mock alone**
  and give the picker its own `mockResolvedValueOnce`, then account for the extra call.

Add `pickWorkspace` to the `TestHost` interface:

```ts
  pickWorkspace(): Promise<{ id: string; title: string } | null>;
```

Append to the end of the existing `it`, after the `openWorkspace("../evil")` assertion:

```ts
    // The picker lists only workspaces the viewer owns: `owner` is set exactly when they are a
    // collaborator instead. It renders as host chrome in the Workshop document, not in the frame.
    const OTHERS_WORKSPACE_ID = "c".repeat(64);
    listGadgets.mockResolvedValueOnce([
      { id: WORKSPACE_ID, title: "Daily Brief" },
      { id: OTHERS_WORKSPACE_ID, title: "Someone Else's", owner: { name: "Ada" } },
    ]);

    const picked = host.pickWorkspace();
    await act(async () => { await Promise.resolve(); });
    const options = [...document.querySelectorAll('[data-testid="workspace-option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["Daily Brief"]);

    await act(async () => { (options[0] as HTMLElement).click(); });
    await expect(picked).resolves.toEqual({ id: WORKSPACE_ID, title: "Daily Brief" });

    // Dismissing resolves null rather than hanging or throwing.
    listGadgets.mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Daily Brief" }]);
    const dismissed = host.pickWorkspace();
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      (document.querySelector('[data-testid="workspace-picker-cancel"]') as HTMLElement).click();
    });
    await expect(dismissed).resolves.toBeNull();
```

The `listGadgets` mock's element type needs `owner?: { name: string }` added so the new rows
typecheck; widen the `vi.fn<...>` generic in place without changing its default implementation.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/workshop-frontend && pnpm exec vitest run SandboxedGatekeeperApp
```

Expected: FAIL — `host.pickWorkspace is not a function`.

- [ ] **Step 3: Create the picker component**

Create `packages/workshop-frontend/src/GatekeeperWorkspacePicker.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useAuthenticatedApi } from './AuthContext'

/** One selectable workspace. Only workspaces the user owns are ever listed. */
export type PickableWorkspace = { id: string; title: string }

/**
 * Workshop-owned workspace picker, presented on behalf of a sandboxed gatekeeper app.
 *
 * The app never receives the list — only the single workspace the user picks. This keeps the
 * host-bridge invariant that the frame learns nothing it was not handed (see
 * SandboxedGatekeeperApp's resolveWorkspaceTitles: "Deliberately a lookup, not an enumeration").
 */
export default function GatekeeperWorkspacePicker({
  onPick,
}: {
  onPick: (workspace: PickableWorkspace | null) => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [workspaces, setWorkspaces] = useState<PickableWorkspace[] | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi
      .listGadgets()
      // `owner` is set only when the viewer is a collaborator, so its absence means they own it.
      // `role` is the wrong filter here: the owner is always "build", but so is a build collaborator.
      .then((gadgets) => {
        if (cancelled) return
        setWorkspaces(
          gadgets
            .filter((gadget) => !gadget.owner)
            .map((gadget) => ({ id: gadget.id, title: gadget.title })),
        )
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([])
      })
    return () => {
      cancelled = true
    }
  }, [authenticatedApi])

  return (
    <div
      className="fixed inset-0 z-[2147483001] flex items-center justify-center bg-black/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a workspace"
    >
      <div className="w-full max-w-md rounded-xl bg-kumo-base p-5 shadow-xl">
        <h2 className="text-ui-lg font-semibold text-kumo-strong">Choose a workspace</h2>
        <p className="mt-1 text-ui-sm text-kumo-subtle">
          Everyone chatting in the workspace you pick can use this collection.
        </p>

        <div className="mt-4 flex max-h-72 flex-col gap-1 overflow-y-auto">
          {workspaces === null ? (
            <p className="px-2 py-3 text-ui-sm text-kumo-subtle">Loading…</p>
          ) : workspaces.length === 0 ? (
            <p className="px-2 py-3 text-ui-sm text-kumo-subtle">
              You don’t own any workspaces yet. Create one first.
            </p>
          ) : (
            workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                data-testid="workspace-option"
                onClick={() => onPick(workspace)}
                className="rounded-lg px-3 py-2 text-left text-ui-md text-kumo-default hover:bg-kumo-fill"
              >
                {workspace.title}
              </button>
            ))
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            data-testid="workspace-picker-cancel"
            onClick={() => onPick(null)}
            className="rounded-lg border border-kumo-line px-3 py-1.5 text-ui-sm font-medium"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Expose it on the host capability**

In `packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx`:

Add the callback type beside `ResolveWorkspaceTitles`:

```ts
// Presents the Workshop's own picker and resolves to the single workspace the user chose (null if
// dismissed). Deliberately a pick, not an enumeration: the app learns one workspace, never the list.
type PickWorkspace = () => Promise<PickableWorkspace | null>
```

Import the component and its type:

```ts
import GatekeeperWorkspacePicker, { type PickableWorkspace } from './GatekeeperWorkspacePicker'
```

In `GatekeeperAppHostImpl`, add the field, the constructor parameter and assignment (following
`resolveWorkspaceTitles`), then the method:

```ts
  // The app calls this to let the user choose one workspace. Only the pick crosses back.
  pickWorkspace(): Promise<PickableWorkspace | null> {
    return this.#pickWorkspace()
  }
```

In the `SandboxedGatekeeperApp` component, hold the pending request and render the picker:

```tsx
  const [pendingPick, setPendingPick] = useState<
    ((workspace: PickableWorkspace | null) => void) | null
  >(null)
  const pickWorkspace = useCallback<PickWorkspace>(() => {
    return new Promise((resolve) => {
      // Wrapped in an object: a bare function passed to a state setter would be *called*.
      setPendingPick(() => (workspace: PickableWorkspace | null) => {
        setPendingPick(null)
        resolve(workspace)
      })
    })
  }, [])
```

Pass `pickWorkspace` into the `GatekeeperAppHostImpl` construction and add it to that `useCallback`/
`useMemo` dependency array alongside `resolveWorkspaceTitles`. Render the picker beside the iframe:

```tsx
      {pendingPick ? <GatekeeperWorkspacePicker onPick={pendingPick} /> : null}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd packages/workshop-frontend && pnpm exec vitest run SandboxedGatekeeperApp
```

Expected: PASS, including the pre-existing `resolveWorkspaceTitles` tests — the widened
`listGadgets` mock adds a second workspace, so if a title-lookup assertion counts rows, update it to
expect the owned one only where it looks up `WORKSPACE_ID`.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-frontend/src/GatekeeperWorkspacePicker.tsx \
        packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx \
        packages/workshop-frontend/src/SandboxedGatekeeperApp.test.tsx
git commit -m "feat(frontend): let a gatekeeper app ask the user to pick one workspace"
```

---

### Task 6: The New collection dialog and collection settings

Implements spec §9.2, §7.2, §6.3.

**Files:**
- Modify: `packages/gatekeeper-context/app/bridge.ts`
- Modify: `packages/gatekeeper-context/app/ContextLibraryPage.tsx`
- Regenerate: `packages/gatekeeper-context/src/generated/app.txt`

**Interfaces:**
- Consumes: `pickWorkspace()` (Task 5); `createContextCollection(..., workspaceId?)`,
  `getContextCollectionWorkspace`, `revokeContextCollectionWorkspace` (Task 2);
  `EnabledCollectionInfo.workspaceId` (Task 3).
- Produces: no exports other tasks depend on. This is the last task.

- [ ] **Step 1: Add the two host-bridge hooks**

The Context app currently reaches only three host methods: its `HostCapability` interface in
`app/main.tsx` declares `ui`, `setPresenting` and `subscribeTheme`. This task needs **two** more —
`pickWorkspace` (Task 5) and `resolveWorkspaceTitles` (already on the host, used by the Scheduler
app but never by this one). Both must be declared and wired, or Step 4 references something that
does not exist.

In `packages/gatekeeper-context/app/bridge.ts`, add beside the other contexts:

```ts
/**
 * One workspace the user chose in the Workshop's picker. Named separately from the frontend's
 * `PickableWorkspace`: the sandboxed app cannot import from workshop-frontend, so the two packages
 * describe the same wire shape independently.
 */
export type PickedWorkspace = { id: string; title: string }

/**
 * Ask the host to present its workspace picker. Resolves to the chosen workspace, or null if the
 * user dismissed it. The app never receives the workspace list — by design.
 */
export type WorkspacePicker = () => Promise<PickedWorkspace | null>

/** Resolve workspace ids the app already holds to live titles; null if no longer visible. */
export type WorkspaceTitleResolver = (ids: string[]) => Promise<(string | null)[]>

const WorkspacePickerContext = createContext<WorkspacePicker>(async () => null)
const WorkspaceTitlesContext = createContext<WorkspaceTitleResolver>(
  async (ids) => ids.map(() => null))

export function useWorkspacePicker(): WorkspacePicker {
  return useContext(WorkspacePickerContext)
}

export function useResolveWorkspaceTitles(): WorkspaceTitleResolver {
  return useContext(WorkspaceTitlesContext)
}

/** Supplies the two workspace host capabilities to the app tree. */
export function WorkspaceHostProvider({
  pickWorkspace,
  resolveWorkspaceTitles,
  children,
}: {
  pickWorkspace: WorkspacePicker
  resolveWorkspaceTitles: WorkspaceTitleResolver
  children: ReactNode
}) {
  return createElement(
    WorkspacePickerContext.Provider,
    { value: pickWorkspace },
    createElement(WorkspaceTitlesContext.Provider, { value: resolveWorkspaceTitles }, children),
  )
}
```

In `packages/gatekeeper-context/app/main.tsx`, extend the `HostCapability` interface:

```ts
  // Presents the Workshop's workspace picker; resolves to the chosen workspace or null.
  pickWorkspace(): Promise<{ id: string; title: string } | null>
  // Resolves workspace ids this app already holds to their live titles.
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>
```

and mount the provider inside `PresentationProvider`:

```tsx
      <WorkspaceHostProvider
        pickWorkspace={() => host.pickWorkspace()}
        resolveWorkspaceTitles={(ids) => host.resolveWorkspaceTitles(ids)}
      >
```

closing it before `</PresentationProvider>`, and add `WorkspaceHostProvider` to the `./bridge`
import.

- [ ] **Step 2: Un-gate the Visibility group, then add the third option**

**Read this before touching the file.** The entire Visibility section is wrapped in
`{isAdmin && (` (around line 855) — non-admins see no Visibility control at all today and get
`private` implicitly. Adding the third option inside that block would make workspace visibility
**admin-only**, which contradicts the design (§9.2: "Offered to all users, unlike Everyone") and
would render the whole feature useless for ordinary users.

So invert the gating: render the group for everyone, and filter the **public option** to admins.
Replace `{isAdmin && (` … `)}` around the Visibility block with an unconditional block, and filter
the list where it is mapped:

```tsx
                  {VISIBILITY_OPTIONS
                    // "Everyone" is a deployment-wide publication, so it stays admin-only. The other
                    // two are scoped to the user's own account or their own workspace.
                    .filter((option) => option.value !== "public" || isAdmin)
                    .map(({
```

This is a deliberate UI change for non-admins: they go from *no* Visibility section to one with two
options (Only me / Workspace). Keep the `ctx-rise` wrapper and its `animationDelay` exactly as they
are so the section's entrance animation still lines up with its neighbours.

Then add to `VISIBILITY_OPTIONS`, between the `private` and `public` entries so the dialog reads
narrow → wide:

```tsx
  {
    value: "workspace" as const,
    Icon: UsersThree,
    title: "Workspace",
    description:
      "Available to everyone chatting in one workspace, and only there. Your agents in other " +
      "workspaces won't see it.",
  },
```

Import `UsersThree` from `@phosphor-icons/react` alongside the existing icon imports. The copy must
state exclusivity — this is the whole point of the tier, and the earlier draft of the design got it
wrong in the other direction.

- [ ] **Step 3: Wire selection, validation and create**

In `CreateCollectionView`, add state and the picker:

```tsx
  const pickWorkspace = useWorkspacePicker();
  const [workspace, setWorkspace] = useState<PickedWorkspace | null>(null);

  const chooseWorkspace = async () => {
    const picked = await pickWorkspace();
    if (picked) setWorkspace(picked);
  };
```

Render the control directly beneath the visibility radiogroup, only when `workspace` visibility is
selected:

```tsx
              {visibility === "workspace" ? (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={chooseWorkspace}
                    className="w-full rounded-lg border border-kumo-line px-3 py-2 text-left text-ui-md"
                  >
                    {workspace ? workspace.title : "Choose workspace…"}
                  </button>
                  {workspace ? null : (
                    <p className="mt-1.5 text-ui-xs text-kumo-subtle">
                      Pick the workspace whose chats can use this collection.
                    </p>
                  )}
                </div>
              ) : null}
```

**Deliberate divergence from spec §9.2.** The spec says the Workspace *option* renders disabled when
the user owns no workspace. That is not implementable without telling the frame how many workspaces
the user owns — the enumeration §4.6 exists to avoid. The empty state lives in the picker instead
(Task 5's component already renders "You don't own any workspaces yet. Create one first."), and
Create stays disabled because nothing was picked. Goal 3 is satisfied: there is no path to creating a
workspace collection without a workspace. The spec has been amended to match.

Gate creation. Add above the return:

```tsx
  // A workspace collection with no workspace would be readable by nobody, so Create stays disabled.
  const canCreate = !!title.trim() && !creating &&
    (visibility !== "workspace" || !!workspace);
```

Use it on the Create button, replacing its current `disabled={!title.trim()}`:

```tsx
              disabled={!canCreate}
```

Leave the neighbouring `loading={creating}` prop alone — it drives the spinner, and `canCreate`
already covers `creating` for the disabled state.

Use `canCreate` for the Create button's `disabled` prop and as the guard in `handleCreate`
(replacing `if (!title.trim() || creating) return;` with `if (!canCreate) return;`), and pass the
workspace through:

```tsx
      const metadata = await context.createContextCollection(
        title.trim(),
        description.trim(),
        visibility,
        icon,
        source,
        visibility === "workspace" ? workspace!.id : undefined,
      );
```

- [ ] **Step 4: Make the settings pane's Source/Access fields three-valued**

This is a correctness fix: today's binary `isPublic ? … : …` would label a workspace-scoped
collection **"Private to you"** while it feeds another workspace's agent. Replace the `isPublic`
derivation and the two `MetaField`s:

```tsx
  const isPublic = metadata.visibility === "public";
  const isWorkspaceScoped = metadata.visibility === "workspace";
```

```tsx
            <MetaField label="Source">
              <span className="inline-flex items-center gap-1.5">
                {isPublic ? <Buildings size={12} className="shrink-0" />
                  : isWorkspaceScoped ? <UsersThree size={12} className="shrink-0" />
                  : <User size={12} className="shrink-0" />}
                {isPublic ? "Your organization" : "You"}
              </span>
            </MetaField>
            <MetaField label="Access">
              {isPublic ? "Everyone (required)"
                : isWorkspaceScoped ? (workspaceTitle ?? "Workspace no longer available")
                : "Private to you"}
            </MetaField>
```

Resolve the title live, so a renamed or deleted workspace is never shown from a stale snapshot —
the host's lookup already returns `null` for a workspace the user can no longer see:

```tsx
  const resolveWorkspaceTitles = useResolveWorkspaceTitles();
  const [workspaceTitle, setWorkspaceTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!metadata.workspaceId) return;
    let cancelled = false;
    resolveWorkspaceTitles([metadata.workspaceId])
      .then(([resolved]) => { if (!cancelled) setWorkspaceTitle(resolved); })
      .catch(() => { if (!cancelled) setWorkspaceTitle(null); });
    return () => { cancelled = true; };
  }, [metadata.workspaceId, resolveWorkspaceTitles]);
```

Import `useResolveWorkspaceTitles` and `useWorkspacePicker` from `./bridge` alongside the existing
`useContextApi` import.

- [ ] **Step 5: Add the revoke action with its consequence stated**

Beside the existing delete action in the settings pane, for `isWorkspaceScoped` only:

```tsx
              {isWorkspaceScoped ? (
                <button type="button" onClick={() => setConfirmingRevoke(true)}>
                  Stop sharing with this workspace
                </button>
              ) : null}
```

The confirmation body must state the consequence and the remedy — this is the sharpest edge in the
whole feature (spec §7.2):

```tsx
                <>
                  This collection becomes private to you, and{" "}
                  <span className="font-medium">
                    {workspaceTitle ?? "that workspace"}
                  </span>{" "}
                  stops using it. Because its agent has already read this collection, new
                  collaborators can’t be added to that workspace until you share this collection
                  with it again.
                </>
```

The handler, mirroring the file's existing mutate-then-refresh-then-toast shape:

```tsx
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const handleRevoke = async () => {
    if (revoking) return;
    setRevoking(true);
    try {
      await context.revokeContextCollectionWorkspace(metadata.id);
      setConfirmingRevoke(false);
      // The pane's visibility, Access field and revoke button all derive from metadata, so the
      // caller's refresh is what makes the collection read as private again.
      await onMetadataChanged();
      toasts.add({ title: "Collection is now private", variant: "success" });
    } catch {
      toasts.add({ title: "Failed to stop sharing", variant: "error" });
    } finally {
      setRevoking(false);
    }
  };
```

`onMetadataChanged` is whatever refresh callback this pane already receives from its parent for the
quick-edit flow — reuse it rather than adding a second refresh path. If the pane refetches metadata
itself instead, call that function here.

- [ ] **Step 6: Badge scoped collections in the list**

At the list-row component (around line 310), where `isPublic` is derived from `source`, leave the
`source` comparison and the sort at line 987 **exactly as they are** (widening `source` breaks that
comparator) and badge from the new field instead:

Add `workspaceId` to the row component's props (it comes straight off the `EnabledCollectionInfo`
the parent maps over), then:

```tsx
  const isPublic = source === "public";
  // Scoped collections are always the viewer's own, so `source` stays "private" — see the global
  // constraint about the sort comparator at line 987.
  const isWorkspaceScoped = !!workspaceId;
```

Where the row renders its public/private affordance, add the third case, keeping the same element
shape and sizing as the two existing ones:

```tsx
        {isPublic ? (
          <Buildings size={12} className="shrink-0" />
        ) : isWorkspaceScoped ? (
          <UsersThree size={12} className="shrink-0" />
        ) : (
          <User size={12} className="shrink-0" />
        )}
```

The badge intentionally shows no workspace title: the list renders many rows, and resolving a title
per row would mean a host round trip per row. The title appears in the settings pane (Step 4), which
opens for one collection at a time.

- [ ] **Step 7: Typecheck the app, then rebuild the committed bundle**

```bash
pnpm --filter @gadgets/gatekeeper-context run typecheck:app
pnpm --filter @gadgets/gatekeeper-context build
```

Expected: no errors. `build` regenerates `src/generated/app.txt`, which is committed — the deployed
UI is that file, so a change that is not rebuilt does not ship.

- [ ] **Step 8: Full verification**

```bash
pnpm lint
pnpm test
```

Expected: PASS. `pnpm lint` runs oxlint plus a recursive `tsc --noEmit`, which is what CI enforces.

- [ ] **Step 9: Manually exercise it**

```bash
pnpm dev-server
```

Then: open Context & Skills → New collection → pick **Workspace** → confirm Create is disabled →
choose a workspace → create → add a document. Open a chat in that workspace and confirm the agent
can list and read it. Open a chat in a *different* workspace and confirm it cannot. Then revoke the
scope and confirm the collection returns to private.

- [ ] **Step 10: Commit**

```bash
git add packages/gatekeeper-context/app/bridge.ts \
        packages/gatekeeper-context/app/ContextLibraryPage.tsx \
        packages/gatekeeper-context/app/main.tsx \
        packages/gatekeeper-context/src/generated/app.txt
git commit -m "feat(context): choose a workspace when creating a collection"
```

---

## Optional follow-ups

Two stale references found while writing the spec. Independent of this feature; fix them separately
if you want them.

- `packages/workshop-shared/src/api.ts` documents `GadgetMetadata.id` as "a url-safe base64 value
  chosen randomly", but it is `DurableObjectId.toString()` — 64 hex characters.
- The root `CLAUDE.md` tells you to regenerate the release-manifest golden with
  `scripts/release-manifest.test.js`, which does not exist. It is
  `UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts`.
