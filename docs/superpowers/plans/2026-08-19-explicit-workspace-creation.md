# Explicit Workspace Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Create workspace" on `/workspaces` actually create a named, immediately-visible empty workspace and drop the user inside it, instead of routing them to the Home chat composer.

**Architecture:** Add a second, non-provisional creation path (`AuthenticatedApi.createWorkspace(title?)`) alongside the existing speculative `newGadget()`, distinguished purely by whether the user's `GadgetRecord` gets a `lastActive` at birth — which is already the codebase's provisional/real bit. On the frontend, the sidebar's `SidebarWorkspacesProvider` owns a new name dialog (it already owns the delete and share dialogs and the workspace list state), triggered from the `/workspaces` route through a tiny event bus mirroring `commandPaletteBus.ts`. Auto-naming is taught to leave user-chosen titles alone.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, Cap'n Web RPC, React 19, TanStack Router, Kumo UI, Tailwind, Vitest (`@cloudflare/vitest-pool-workers` for backend, jsdom for frontend).

**Spec:** This document's "Spec" section below (the design was settled in conversation; there is no separate spec file).

---

## Spec

Current behavior: the `+ Create workspace` button on `/workspaces` is a `Link to="/"` ([workspaces.tsx:24-30](../../../packages/workshop-frontend/src/routes/workspaces.tsx#L24-L30)). It creates nothing and lands the user on the Home composer, which never mentions workspaces. The workspace is only created when the first message is sent, and is then auto-named after that message.

Required behavior:

1. Clicking `Create workspace` on `/workspaces` opens a modal dialog with a workspace **name** field.
2. Confirming creates a real, empty workspace immediately.
3. The new workspace appears in the sidebar's **Recent workspaces** list immediately, without a page reload.
4. The user is navigated into the new workspace, which shows the existing chat UI with an empty conversation list.
5. Starting a chat there creates the chat **inside** that workspace (existing behavior — no change needed).
6. A workspace named by the user is never silently renamed by auto-naming.

Explicit non-goals (deliberate, not oversights):

- **Home is unchanged.** It keeps its provisional pre-warmed workspace and its auto-naming. It remains the chat-first fast path.
- **The ⌘K "New workspace" action is unchanged** ([CommandPalette.tsx:239](../../../packages/workshop-frontend/src/components/AppShell/CommandPalette.tsx#L239)). It stays the chat-first path to Home. The dialog is the container-first path from `/workspaces`.
- **No per-workspace description, icon, or instructions.** `title` is the only user-authored field on `GadgetMetadata` today; adding fields is out of scope.
- **No new title length validation on the server.** `Overseer.setTitle()` does not trim or cap ([overseer.ts:7233-7236](../../../packages/workshop-backend/src/overseer.ts#L7233-L7236)); `createWorkspace` deliberately mirrors that leniency. The dialog applies a `maxLength` as a UI guard only.
- **Blueprint-instantiated and external-message workspace titles keep their current behavior** — they are still auto-renamed on the first code merge. Protecting them is a separate product question (see Task 2).
- **No per-user cap on workspace count.** Verified: no such quota exists today (`limits.ts` governs AI spend only), so `createWorkspace` introduces no bypass. Empty workspaces are one row plus a lazily-materialized DO, and the user deletes them from the rail's row menu.

**A behavior worth being deliberate about:** creating a workspace with the name field left **blank** produces `Untitled Workspace`, which stays eligible for automatic naming — so its first chat renames it, exactly as through Home. This is intended: the user declined to name it, and a real name beats `Untitled Workspace` forever. Naming it in the dialog opts out of automatic naming permanently.

## Global Constraints

- **pnpm only.** Never `npm`. Verification commands: `pnpm build`, `pnpm test`, `pnpm lint`.
- **Kernel review bar.** `workshop-backend` and `workshop-shared` are the kernel — reviewers read every line. Keep diffs small; doc-comment **every** exported member added to the `workshop-shared` public API (types, consts, and functions).
- **Two PRs.** Tasks 1–3 are the kernel PR (`workshop-shared` + `workshop-backend`). Tasks 4–5 are the UI PR (`workshop-frontend`). Commit them so the kernel can be reviewed apart from the UI.
- **Task order is load-bearing.** Task 2 must land before Task 3: Task 3's `createWorkspace` protects the user's name only because Task 2 made `setTitle` latch `titleChosenByUser`. Shipping Task 3 first would give users a dialog whose name gets silently overwritten on the first code merge. Task 5 needs Task 3 (it calls `createWorkspace`). Task 4 has no dependency and may be built in parallel.
- **Never add AI/LLM attribution or `Co-Authored-By` metadata** to commits or any file.
- **RPC stubs must be disposed.** Call `stub[Symbol.dispose]()` when done, or use `using`.
- **Prefer reusing existing mechanisms over adding parallel ones** (CLAUDE.md).
- **Exact copy strings** (use verbatim):
  - Default workspace title: `Untitled Workspace`
  - Legacy default title still in old records: `Untitled Gadget`
  - Dialog title: `Create workspace`
  - Dialog description: `An isolated environment for a set of conversations, connections, and outputs.`
  - Name field label: `Name`, placeholder: `e.g. GTM Q3`, description: `Optional — you can rename it any time.`
  - Confirm button: `Create` / while creating: `Creating...`
  - Failure toast: `Failed to create workspace`
- **Lint rules that will bite:** unused imports and unused local variables are **errors** (unused function params and caught errors are not).

---

## File Structure

**Kernel PR (Tasks 1–3)**

| File | Responsibility |
|---|---|
| `packages/workshop-shared/src/api.ts` | Modify: export `DEFAULT_WORKSPACE_TITLE`; add `createWorkspace(title?)` to `AuthenticatedApi`. |
| `packages/workshop-backend/src/workspace-title.ts` | **Create.** One tiny, DO-free, unit-testable predicate: is a stored title a system default that auto-naming may replace? |
| `packages/workshop-backend/src/overseer.ts` | Modify: use the const + predicate; guard `generateGadgetTitle` against user-chosen titles. |
| `packages/workshop-backend/src/user.ts` | Modify: `newGadget()` takes an optional `lastActive` so a workspace can be born non-provisional. |
| `packages/workshop-backend/src/server.ts` | Modify: implement `createWorkspace()`. |
| `packages/workshop-backend/src/analytics.ts` | Modify: widen `gadget_created.source` with `"named"`. |
| `packages/workshop-backend/__tests__/workspace-title.test.ts` | **Create.** Covers the predicate exhaustively. |
| `packages/workshop-backend/__tests__/workspace-creation.test.ts` | **Create.** Covers the provisional-vs-real visibility rule against the real User DO. |

**UI PR (Tasks 4–5)**

| File | Responsibility |
|---|---|
| `packages/workshop-frontend/src/components/CreateWorkspaceDialog.tsx` | **Create.** Presentational dialog only — no RPC, no navigation. Modeled on `DeleteConfirmationDialog.tsx`. |
| `packages/workshop-frontend/src/components/AppShell/createWorkspaceBus.ts` | **Create.** Event bus so a route can ask the sidebar-owned dialog to open. Mirrors `commandPaletteBus.ts`. |
| `packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx` | Modify: own the dialog, do the RPC, splice the result into list state, navigate. |
| `packages/workshop-frontend/src/routes/workspaces.tsx` | Modify: the button opens the dialog instead of linking to `/`. |
| `packages/workshop-frontend/src/CreateWorkspaceDialog.test.tsx` | **Create.** Dialog behavior in jsdom. |

### Two facts that constrain the design — do not "simplify" these away

1. **`lastActive` is the provisional bit.** `listGadgets()` filters on `isFullyCreated(g)`, which is exactly `g.lastActive !== undefined` ([user.ts:105-107](../../../packages/workshop-backend/src/user.ts#L105-L107), [user.ts:704-712](../../../packages/workshop-backend/src/user.ts#L704-L712)). Do **not** make the existing `newGadget()` always set it — Home mints a provisional workspace on first interaction and disposes it if the user never sends ([index.tsx:84-96](../../../packages/workshop-frontend/src/routes/index.tsx#L84-L96)), and that filter is what keeps those out of the user's lists.

2. **The sidebar sort dereferences `lastActive` unguarded.** `byActive` does `b.lastActive.getTime()` ([SidebarWorkspaces.tsx:131-132](../../../packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx#L131-L132)). Any object spliced into `gadgets` state **must** carry a real `Date` in `lastActive` or the sidebar throws on next render.

Also note: the title is stored in **two** places — the Overseer's own `storage.title` ([overseer.ts:687](../../../packages/workshop-backend/src/overseer.ts#L687)) and the user's `GadgetRecord.title`. `Overseer.setTitle()` is the only writer that updates both ([overseer.ts:7233-7236](../../../packages/workshop-backend/src/overseer.ts#L7233-L7236)), which is why Task 3 routes the chosen name through it rather than seeding both by hand.

---

## Task 1: Single source of truth for the default workspace title

**Files:**
- Modify: `packages/workshop-shared/src/api.ts` (insert above line 1187, `export type GadgetMetadata = {`)
- Create: `packages/workshop-backend/src/workspace-title.ts`
- Create: `packages/workshop-backend/__tests__/workspace-title.test.ts`
- Modify: `packages/workshop-backend/src/overseer.ts:687`, `packages/workshop-backend/src/overseer.ts:5177`
- Modify: `packages/workshop-backend/src/server.ts:266`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `DEFAULT_WORKSPACE_TITLE: string` exported from `@gadgets/workshop-shared/api` (value `"Untitled Workspace"`).
  - `isReplaceableWorkspaceTitle(title: string): boolean` exported from `packages/workshop-backend/src/workspace-title.ts`.

This is a pure refactor: no behavior change. It exists so Task 2's guard and Task 3's fallback share one definition instead of re-typing the literal a sixth time.

- [ ] **Step 1: Write the failing test**

Create `packages/workshop-backend/__tests__/workspace-title.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_TITLE } from "@gadgets/workshop-shared/api";
import { isReplaceableWorkspaceTitle } from "../src/workspace-title.js";

describe("isReplaceableWorkspaceTitle", () => {
  it("treats the current default as replaceable", () => {
    expect(isReplaceableWorkspaceTitle(DEFAULT_WORKSPACE_TITLE)).toBe(true);
  });

  it("treats the pre-rename default in old records as replaceable", () => {
    expect(isReplaceableWorkspaceTitle("Untitled Gadget")).toBe(true);
  });

  it("protects a title a person chose", () => {
    expect(isReplaceableWorkspaceTitle("GTM Q3")).toBe(false);
  });

  it("protects a title that merely contains the default", () => {
    expect(isReplaceableWorkspaceTitle("Untitled Workspace copy")).toBe(false);
  });

  it("does not treat a padded default as replaceable, since no writer stores one", () => {
    expect(isReplaceableWorkspaceTitle(" Untitled Workspace ")).toBe(false);
  });

  // Matches today's behavior: the old inline check was an array `.includes()`, so an empty title
  // was never auto-replaced either. Preserved deliberately -- setTitle("") is reachable.
  it("does not treat an empty title as replaceable", () => {
    expect(isReplaceableWorkspaceTitle("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/workspace-title.test.ts`

Expected: FAIL — cannot resolve `../src/workspace-title.js`, and `DEFAULT_WORKSPACE_TITLE` is not exported from the shared api.

- [ ] **Step 3: Add the shared constant**

In `packages/workshop-shared/src/api.ts`, insert immediately **above** `export type GadgetMetadata = {` (line 1187), before its leading comment block:

```ts
// The title a workspace is given when whoever created it didn't name it. Auto-naming may replace a
// title equal to this one (and the pre-rename "Untitled Gadget" still found in old records); any
// other title was chosen by a person and is left alone.
export const DEFAULT_WORKSPACE_TITLE = "Untitled Workspace";
```

- [ ] **Step 4: Create the predicate module**

Create `packages/workshop-backend/src/workspace-title.ts`:

```ts
import { DEFAULT_WORKSPACE_TITLE } from "@gadgets/workshop-shared/api";

// Workspaces created before the gadget-to-workspace rename started out with this title. Old records
// still carry it, so auto-naming has to treat it as a default too.
const LEGACY_DEFAULT_GADGET_TITLE = "Untitled Gadget";

// True when `title` is a system-assigned default that auto-naming is free to overwrite. Anything
// else was typed by a person -- at creation (createWorkspace) or later (setTitle) -- and must
// survive both the first-chat rename and the first-code-merge rename.
export function isReplaceableWorkspaceTitle(title: string): boolean {
  return title === DEFAULT_WORKSPACE_TITLE || title === LEGACY_DEFAULT_GADGET_TITLE;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/workspace-title.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 6: Replace the remaining inline literals**

In `packages/workshop-backend/src/overseer.ts`, add `DEFAULT_WORKSPACE_TITLE` to the existing `@gadgets/workshop-shared/api` import and add an import of the new predicate:

```ts
import { isReplaceableWorkspaceTitle } from "./workspace-title.js";
```

Then line 687, from:

```ts
      title: "Untitled Workspace",
```

to:

```ts
      title: DEFAULT_WORKSPACE_TITLE,
```

And line 5177, from:

```ts
      if (chatId === 0 && ["Untitled Gadget", "Untitled Workspace"].includes(this.storage.title.get()) && this.ownerId) {
```

to:

```ts
      if (chatId === 0 && isReplaceableWorkspaceTitle(this.storage.title.get()) && this.ownerId) {
```

In `packages/workshop-backend/src/server.ts`, add `DEFAULT_WORKSPACE_TITLE` to the existing `@gadgets/workshop-shared/api` import, then line 266, from:

```ts
    await this.user.newGadget(id, "Untitled Workspace");
```

to:

```ts
    await this.user.newGadget(id, DEFAULT_WORKSPACE_TITLE);
```

- [ ] **Step 7: Verify nothing else references the literals**

Run: `grep -rn '"Untitled Workspace"\|"Untitled Gadget"' packages/workshop-backend/src packages/workshop-shared/src`

Expected: exactly two hits — the `DEFAULT_WORKSPACE_TITLE` definition in `api.ts` and `LEGACY_DEFAULT_GADGET_TITLE` in `workspace-title.ts`. (Frontend `'Untitled Workspace'` fallbacks are a different concern — rendering an empty title — and stay put.)

- [ ] **Step 8: Run the full backend check**

Run: `pnpm --filter @gadgets/workshop-backend test && pnpm lint`

Expected: PASS, no new lint errors.

- [ ] **Step 9: Commit**

```bash
git add packages/workshop-shared/src/api.ts \
        packages/workshop-backend/src/workspace-title.ts \
        packages/workshop-backend/__tests__/workspace-title.test.ts \
        packages/workshop-backend/src/overseer.ts \
        packages/workshop-backend/src/server.ts
git commit -m "refactor(workspace): centralize the default workspace title"
```

---

## Task 2: Stop auto-naming from overwriting a name a person chose

**Files:**
- Modify: `packages/workshop-backend/src/overseer.ts` — storage values (immediately after the `title` field, line 687); `generateThreadTitle` guard (line 5177); `generateGadgetTitle` head (line 5192); `Overseer.setTitle` (lines 7233-7236)

**Interfaces:**
- Consumes: `isReplaceableWorkspaceTitle` from Task 1.
- Produces: `storage.titleChosenByUser` (boolean, defaults `false`) — set by `Overseer.setTitle()`, which is how Task 3's `createWorkspace` inherits it for free.

### Do NOT guard `generateGadgetTitle` on the title string — it breaks the Home path

A title-string check looks like the obvious guard and is **wrong**. Auto-naming today is deliberately two-stage ([overseer.ts:5174-5176](../../../packages/workshop-backend/src/overseer.ts#L5174-L5176) and [overseer.ts:5192](../../../packages/workshop-backend/src/overseer.ts#L5192)):

1. First chat in a fresh workspace → `generateThreadTitle` renames the workspace to the chat's title (e.g. `Go vs TypeScript: Language Comparison`), because the user still perceives it as just a chat.
2. First accepted code merge → `generateGadgetTitle` renames it again to a project name (e.g. `Campaign Brief Generator`), because it has now become a thing rather than a conversation.

By the time stage 2 runs, the title is **already a non-default string that automation wrote**. So `if (!isReplaceableWorkspaceTitle(title)) return;` would suppress stage 2 for *every workspace created through Home* — silently deleting the project-naming feature. A string cannot distinguish "automation wrote this" from "a person wrote this"; only a stored flag can.

**What sets the flag:** `storage.title` has five writers. Only `Overseer.setTitle()` ([overseer.ts:7233](../../../packages/workshop-backend/src/overseer.ts#L7233)) represents a person naming the workspace — its four callers are all rename UI (`GadgetEditor.tsx:1215`, `GadgetList.tsx:312`, `SidebarWorkspaces.tsx:159`, and Task 3's `createWorkspace`). The two auto-namers write `storage.title` directly and so can never trip the flag. The remaining two writers — external-message workspace creation ([overseer.ts:6513](../../../packages/workshop-backend/src/overseer.ts#L6513)) and blueprint instantiation ([overseer.ts:6609](../../../packages/workshop-backend/src/overseer.ts#L6609)) — deliberately do **not** set it, which preserves their current behavior exactly (both are auto-renamed on first code merge today). Whether a blueprint's title deserves protection is a separate product question; leave it out of this PR.

**Testing limitation, stated honestly:** `generateGadgetTitle` calls `completeText()` against a real model and the test env has no gateway credentials, so there is no fast unit test that drives either auto-namer end to end. Coverage is Task 1's predicate tests plus the manual walk in Step 5 — which exercises **both** directions (a named workspace keeps its name; an unnamed one still gets both automatic renames). Do not invent a mock-heavy test that only asserts a stub was called.

- [ ] **Step 1: Add the storage flag**

In `packages/workshop-backend/src/overseer.ts`, immediately after the `title` field in the storage values (line 687, which Task 1 changed to `title: DEFAULT_WORKSPACE_TITLE,`), add:

```ts

      // True once a person has named this workspace -- in the create dialog (createWorkspace) or by
      // renaming it (setTitle). Automatic naming writes `title` directly and never sets this, so a
      // workspace nobody has named still gets both automatic stages: the first chat's title, then a
      // project name once code is written. Absent on records predating this field, which reads as
      // false and so keeps their existing behavior.
      titleChosenByUser: false,
```

- [ ] **Step 2: Record the flag when a person renames**

Change `Overseer.setTitle` (lines 7233-7236) from:

```ts
  async setTitle(title: string): Promise<void> {
    this.impl.storage.title.put(title);
    await this.owner.updateTitle(this.impl.ctx.id.toString(), title);
  }
```

to:

```ts
  // The only title writer that represents a person's choice, so it is also the one that latches
  // `titleChosenByUser` and takes this workspace out of automatic naming for good.
  async setTitle(title: string): Promise<void> {
    this.impl.storage.title.put(title);
    this.impl.storage.titleChosenByUser.put(true);
    await this.owner.updateTitle(this.impl.ctx.id.toString(), title);
  }
```

- [ ] **Step 3: Guard both auto-namers on the flag**

In `generateGadgetTitle`, change the head (line 5192) from:

```ts
  // Generate a title for the whole gadget, called only after code starts being written.
  async generateGadgetTitle(chatId: number, modelConfig: AiModelConfig,
                            initiator: AiChatAuthorInfo) {
    try {
      let parts: string[] = [];
```

to:

```ts
  // Generate a title for the whole gadget, called only after code starts being written.
  //
  // Deliberately checks only the flag, not the title: at this point the title is usually the one
  // generateThreadTitle already wrote, and renaming that to a project name is the whole point. Only
  // a name a person chose is off limits. Returning early also skips paying for a discarded name.
  async generateGadgetTitle(chatId: number, modelConfig: AiModelConfig,
                            initiator: AiChatAuthorInfo) {
    if (this.storage.titleChosenByUser.get()) return;

    try {
      let parts: string[] = [];
```

Leave the `if (title && this.ownerId)` write at line 5219 exactly as it is.

Then in `generateThreadTitle`, extend the guard Task 1 already rewrote (line 5177) from:

```ts
      if (chatId === 0 && isReplaceableWorkspaceTitle(this.storage.title.get()) && this.ownerId) {
```

to:

```ts
      if (chatId === 0 && !this.storage.titleChosenByUser.get() &&
          isReplaceableWorkspaceTitle(this.storage.title.get()) && this.ownerId) {
```

The title check stays: it is what stops this stage from clobbering a meaningful title on a record that predates the flag. The flag check additionally respects someone who deliberately renamed a workspace *to* `Untitled Workspace`.

- [ ] **Step 4: Verify types and existing tests**

Run: `pnpm --filter @gadgets/workshop-backend test && pnpm lint`

Expected: PASS. No existing test asserts unconditional renaming. If one fails, read it before changing it — it may be encoding the old behavior deliberately.

- [ ] **Step 5: Manual verification of both directions**

With `pnpm dev-server` running.

Regression side — the Home two-stage flow must still work end to end:
1. From Home, send a first message that will lead to code (e.g. "build me a tip calculator"). Confirm the workspace title becomes a chat-style title.
2. Accept the agent's first code change. Confirm the workspace title changes **again**, to a project-style name.
3. If it does not change at step 2, the flag is being set somewhere it shouldn't be — stop and fix before continuing.

Protection side — a chosen name must survive:
4. Rename that workspace to `Guard Check` with the pencil in the workspace header.
5. Ask for another change that writes code and accept it.
6. Confirm the title is still `Guard Check` in both the header and the sidebar.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-backend/src/overseer.ts
git commit -m "fix(workspace): keep a user-chosen title through auto-naming"
```

---

## Task 3: `createWorkspace(title?)` — a workspace that exists before any chat

**Files:**
- Modify: `packages/workshop-backend/src/user.ts:736-739` (`newGadget`)
- Modify: `packages/workshop-shared/src/api.ts` (insert after `newGadget()` at line 473)
- Modify: `packages/workshop-backend/src/server.ts` (insert after `newGadget()`, line 278)
- Modify: `packages/workshop-backend/src/analytics.ts:35-36`
- Create: `packages/workshop-backend/__tests__/workspace-creation.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_WORKSPACE_TITLE` from Task 1.
- Produces:
  - `UserDurableObject.newGadget(id: string, title: string, lastActive?: Date): Promise<void>` — third parameter added, existing two-argument callers unaffected.
  - `AuthenticatedApi.createWorkspace(title?: string): Promise<RpcStub<Overseer>>` — consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `packages/workshop-backend/__tests__/workspace-creation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_WORKSPACE_TITLE } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

async function withUser(
    name: string, body: (user: UserDurableObject) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_USER.getByName(name), body);
}

// `lastActive` is the provisional bit (see isFullyCreated): Home's speculative workspace must stay
// out of the user's lists, while a workspace the user asked for by name must appear at once.
describe("workspace visibility at registration", () => {
  it("hides a workspace registered with no last-active time", async () => {
    await withUser("visibility-provisional", async (user) => {
      await user.newGadget("ws-provisional", DEFAULT_WORKSPACE_TITLE);
      expect(await user.listGadgets()).toEqual([]);
    });
  });

  it("lists a workspace registered with a last-active time", async () => {
    await withUser("visibility-explicit", async (user) => {
      await user.newGadget("ws-explicit", "GTM Q3", new Date());

      const listed = await user.listGadgets();
      expect(listed.map((g) => g.id)).toEqual(["ws-explicit"]);
      expect(listed[0]!.title).toBe("GTM Q3");
    });
  });

  // The sidebar's Favorites/Recent sort calls lastActive.getTime() with no null check, so a record
  // that survives storage as anything but a Date would break rendering rather than just sorting.
  it("round-trips last-active through storage as a Date", async () => {
    await withUser("visibility-date", async (user) => {
      await user.newGadget("ws-date", "GTM Q3", new Date());

      const listed = await user.listGadgets();
      expect(listed[0]!.lastActive).toBeInstanceOf(Date);
      expect(Number.isNaN(listed[0]!.lastActive.getTime())).toBe(false);
    });
  });

  it("leaves an explicitly registered workspace visible alongside a provisional one", async () => {
    await withUser("visibility-mixed", async (user) => {
      await user.newGadget("ws-hidden", DEFAULT_WORKSPACE_TITLE);
      await user.newGadget("ws-shown", "GTM Q3", new Date());

      const listed = await user.listGadgets();
      expect(listed.map((g) => g.id)).toEqual(["ws-shown"]);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/workspace-creation.test.ts`

Expected: FAIL — `newGadget` accepts only two arguments, so the three-argument calls are type errors and the `lastActive` assertions fail.

- [ ] **Step 3: Let `newGadget` register a non-provisional workspace**

In `packages/workshop-backend/src/user.ts`, replace lines 736-739:

```ts
  async newGadget(id: string, title: string): Promise<void> {
    let created = new Date();
    this.storage.gadgets.put({id, title, created});
  }
```

with:

```ts
  // Register a workspace in this user's collection.
  //
  // `lastActive` marks it fully created at birth (see isFullyCreated) -- the explicit-creation
  // path, where the user named the workspace before it has any content, so it has to show up in
  // their lists right away. Omit it for the speculative path, where the workspace stays provisional
  // and hidden until real activity records a time.
  async newGadget(id: string, title: string, lastActive?: Date): Promise<void> {
    let created = new Date();
    this.storage.gadgets.put({id, title, created, ...(lastActive ? {lastActive} : {})});
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/workspace-creation.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Widen the analytics source union**

In `packages/workshop-backend/src/analytics.ts`, replace lines 35-36:

```ts
      // Whether the gadget was created from empty chat or via blueprint.
      source: "blank" | "blueprint";
```

with:

```ts
      // Whether the gadget was created from an empty chat, named up front by the user, or from a
      // blueprint.
      source: "blank" | "named" | "blueprint";
```

- [ ] **Step 6: Declare `createWorkspace` on the RPC interface**

In `packages/workshop-shared/src/api.ts`, insert immediately after `newGadget(): Promise<RpcStub<Overseer>>;` (line 473):

```ts

  // Create a new workspace that exists as soon as this call returns, titled `title` (trimmed;
  // falls back to DEFAULT_WORKSPACE_TITLE when blank or absent).
  //
  // Unlike newGadget(), the result is never provisional: it appears in listGadgets() before it has
  // any chat or code, because the user asked for it by name rather than starting to type. Use
  // newGadget() for the speculative path where the user may never send anything at all.
  //
  // A non-blank `title` counts as user-chosen, so auto-naming will not later replace it.
  //
  // TODO(multi-gadget): newGadget() should be renamed to newWorkspace() to sit beside this.
  createWorkspace(title?: string): Promise<RpcStub<Overseer>>;
```

- [ ] **Step 7: Implement it**

In `packages/workshop-backend/src/server.ts`, insert after the closing brace of `newGadget()` (line 278):

```ts

  async createWorkspace(title?: string): Promise<RpcStub<Overseer>> {
    let chosen = (title ?? "").trim();
    let id = this.overseers.newUniqueId().toString();
    // A last-active time at birth: the user named this workspace, so it is real even while empty.
    await this.user.newGadget(id, DEFAULT_WORKSPACE_TITLE, new Date());
    recordAnalytics(this.ctx, this.env, {
      event_name: "gadget_created",
      user_id: this.user.id.toString(),
      gadget_id: id,
      source: "named",
    });
    let result = await this.openGadget(id);
    if (!result) {
      throw new Error("Open failed despite newly-created workspace?");
    }
    // setTitle is the one writer that keeps the Overseer's own title and the user's record in step,
    // so route the chosen name through it rather than seeding the two copies by hand. It also
    // latches titleChosenByUser, which is exactly right here: the user typed this name, so no
    // automatic naming should ever replace it.
    //
    // A blank name deliberately skips this: the workspace keeps the default title AND stays eligible
    // for automatic naming, so someone who couldn't be bothered to name it still ends up with
    // something better than "Untitled Workspace".
    if (chosen) {
      await result.setTitle(chosen);
    }
    return result;
  }
```

- [ ] **Step 8: Verify types, tests and lint**

Run: `pnpm --filter @gadgets/workshop-backend test && pnpm --filter @gadgets/workshop-shared build && pnpm lint`

Expected: PASS. `capnweb-validate` runs as part of the backend build/test — if it rejects the new RPC method's shape, read its message before changing the signature.

- [ ] **Step 9: Manual end-to-end verification**

The composition in Step 7 (`newGadget` + `openGadget` + `setTitle`) spans two Durable Objects and is not covered by a fast unit test; the full-stack `__integration__` suite is `describe.skip`-ed for CI timeouts, so don't add coverage there. Verify by hand with `pnpm dev-server` running, from the browser console on an authenticated page — or defer this check to Task 5, which exercises the same path through the UI. If you verify here, confirm: the returned workspace's `getMetadata().title` is the trimmed name, and it appears in `listGadgets()` immediately.

- [ ] **Step 10: Commit**

```bash
git add packages/workshop-backend/src/user.ts \
        packages/workshop-backend/src/server.ts \
        packages/workshop-backend/src/analytics.ts \
        packages/workshop-shared/src/api.ts \
        packages/workshop-backend/__tests__/workspace-creation.test.ts
git commit -m "feat(workspace): add createWorkspace for named, non-provisional workspaces"
```

**This is the end of the kernel PR.** Open it for review before starting Task 4.

---

## Task 4: The create-workspace dialog

**Files:**
- Create: `packages/workshop-frontend/src/components/CreateWorkspaceDialog.tsx`
- Create: `packages/workshop-frontend/src/CreateWorkspaceDialog.test.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1–3 (this component is presentational — no RPC, no navigation).
- Produces: default export `CreateWorkspaceDialog` with props:
  ```ts
  {
    open: boolean
    isCreating?: boolean
    onOpenChange: (open: boolean) => void
    onConfirm: (title: string) => void   // receives the TRIMMED name, or '' when left blank
  }
  ```

The structure mirrors `components/DeleteConfirmationDialog.tsx` exactly (same Kumo `Dialog` wrapper classes, same header/footer layout, same `WorkshopButton`/`WorkshopIconButton` usage) so it looks native to the app without any new design decisions.

- [ ] **Step 1: Write the failing test**

Create `packages/workshop-frontend/src/CreateWorkspaceDialog.test.tsx`:

```tsx
// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@cloudflare/kumo'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import CreateWorkspaceDialog from './components/CreateWorkspaceDialog'

// Kumo's Dialog renders into a portal on document.body, not into the mount container, so every
// query below goes through document.body.
function nameInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('input[type="text"]')
  if (!input) throw new Error('No name input found')
  return input
}

function buttonLabelled(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`No button labelled ${label}`)
  return match as HTMLButtonElement
}

describe('CreateWorkspaceDialog', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  async function render(props: Partial<Parameters<typeof CreateWorkspaceDialog>[0]> = {}) {
    const onConfirm = props.onConfirm ?? vi.fn()
    const onOpenChange = props.onOpenChange ?? vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ToastProvider>
          <CreateWorkspaceDialog
            open
            onConfirm={onConfirm}
            onOpenChange={onOpenChange}
            {...props}
          />
        </ToastProvider>,
      )
    })
    return { onConfirm, onOpenChange }
  }

  async function type(value: string) {
    const input = nameInput()
    await act(async () => {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  it('passes the trimmed name to onConfirm', async () => {
    const { onConfirm } = await render()
    await type('  GTM Q3  ')
    await act(async () => buttonLabelled('Create').click())

    expect(onConfirm).toHaveBeenCalledWith('GTM Q3')
  })

  it('allows creating without a name, passing an empty string', async () => {
    const { onConfirm } = await render()
    await act(async () => buttonLabelled('Create').click())

    expect(onConfirm).toHaveBeenCalledWith('')
  })

  it('submits on Enter in the name field', async () => {
    const { onConfirm } = await render()
    await type('GTM Q3')
    await act(async () => {
      nameInput().closest('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(onConfirm).toHaveBeenCalledWith('GTM Q3')
  })

  it('shows progress and refuses a second submit while creating', async () => {
    const { onConfirm } = await render({ isCreating: true })

    expect(buttonLabelled('Creating...').disabled).toBe(true)
    await act(async () => buttonLabelled('Creating...').click())
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @gadgets/workshop-frontend exec vitest run src/CreateWorkspaceDialog.test.tsx`

Expected: FAIL — cannot resolve `./components/CreateWorkspaceDialog`.

- [ ] **Step 3: Write the component**

Create `packages/workshop-frontend/src/components/CreateWorkspaceDialog.tsx`:

```tsx
import { Dialog, Input } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'

// A UI guard against a pathological paste, not a validated limit: the server mirrors setTitle's
// leniency and stores whatever it is given.
const MAX_TITLE_LENGTH = 120

interface CreateWorkspaceDialogProps {
  open: boolean
  /** True while the create RPC is in flight; blocks a second submit and swaps the button label. */
  isCreating?: boolean
  onOpenChange: (open: boolean) => void
  /** Receives the trimmed name, or '' when the user left the field blank. */
  onConfirm: (title: string) => void
}

// Names a workspace before it exists. Purely presentational -- the owner does the RPC, decides where
// to navigate, and reports failures, so this stays testable without a server.
export default function CreateWorkspaceDialog({
  open,
  isCreating = false,
  onOpenChange,
  onConfirm,
}: CreateWorkspaceDialogProps) {
  const [title, setTitle] = useState('')

  // Every opening starts from an empty field rather than the previous attempt's text.
  useEffect(() => {
    if (open) setTitle('')
  }, [open])

  const submit = () => {
    if (isCreating) return
    onConfirm(title.trim())
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isCreating) onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="!z-[1000] !w-[min(420px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[20%] !-translate-y-0"
        size="sm"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              Create workspace
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              An isolated environment for a set of conversations, connections, and outputs.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton
                {...props}
                className="!h-7 !w-7"
                disabled={isCreating}
                aria-label="Close"
              >
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        {/* A form so Enter in the field creates the workspace. */}
        <form
          className="px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Input
            label="Name"
            placeholder="e.g. GTM Q3"
            description="Optional — you can rename it any time."
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            disabled={isCreating}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </form>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
          <Dialog.Close
            render={(props) => (
              <WorkshopButton {...props} className="!h-9" disabled={isCreating}>
                Cancel
              </WorkshopButton>
            )}
          />
          <WorkshopButton
            tone="primary"
            onClick={submit}
            disabled={isCreating}
            className="!h-9 min-w-[64px]"
          >
            {isCreating ? 'Creating...' : 'Create'}
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @gadgets/workshop-frontend exec vitest run src/CreateWorkspaceDialog.test.tsx`

Expected: PASS, 4 tests. If the `input[type="text"]` selector misses because Kumo's `Input` renders no explicit `type`, change the helper to `input:not([type])`, `input[type="text"]` — adjust the **test helper**, not the component.

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-frontend/src/components/CreateWorkspaceDialog.tsx \
        packages/workshop-frontend/src/CreateWorkspaceDialog.test.tsx
git commit -m "feat(workspaces): add the create-workspace name dialog"
```

---

## Task 5: Wire the dialog to the `/workspaces` button

**Files:**
- Create: `packages/workshop-frontend/src/components/AppShell/createWorkspaceBus.ts`
- Modify: `packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx` (imports at 1-29; provider body from 68; context type at 39-53; context value at 212-223; dialog render at 225-257)
- Modify: `packages/workshop-frontend/src/routes/workspaces.tsx:1-31`

**Interfaces:**
- Consumes: `AuthenticatedApi.createWorkspace(title?)` from Task 3; `CreateWorkspaceDialog` from Task 4.
- Produces: `openCreateWorkspace(): void` and `OPEN_CREATE_WORKSPACE_EVENT: string` from `createWorkspaceBus.ts`.

**Why an event bus rather than context:** `SidebarWorkspacesProvider` wraps only the sidebar's own subtree ([Sidebar.tsx:114-199](../../../packages/workshop-frontend/src/components/AppShell/Sidebar.tsx#L114-L199)); route content renders in a sibling `<main>` ([AppShell.tsx:116](../../../packages/workshop-frontend/src/components/AppShell/AppShell.tsx#L116)), so the `/workspaces` route cannot read `WorkspacesContext`. The codebase already solved exactly this with `commandPaletteBus.ts`, whose comment names the alternative it rejected ("a context that would have to wrap the whole tree"). Mirror it. The dialog must live in the provider — that is the only place that can splice the new workspace into `gadgets` state so it appears in Recent without a reload.

- [ ] **Step 1: Write the failing test**

Create `packages/workshop-frontend/src/createWorkspaceFlow.test.tsx`:

```tsx
// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  createWorkspace: vi.fn(),
  listGadgets: vi.fn<() => Promise<never[]>>(async () => []),
  navigate: vi.fn<(options: unknown) => void>(),
  whoami: vi.fn(async () => null),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => testState.navigate,
  Link: ({ children }: { children?: unknown }) => <span>{children as never}</span>,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: {
      createWorkspace: testState.createWorkspace,
      listGadgets: testState.listGadgets,
      whoami: testState.whoami,
    },
  }),
}))

vi.mock('./ShareModal', () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  SidebarWorkspacesProvider,
  SidebarWorkspacesLists,
} from './components/AppShell/SidebarWorkspaces'
import { openCreateWorkspace } from './components/AppShell/createWorkspaceBus'

function buttonLabelled(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`No button labelled ${label}`)
  return match as HTMLButtonElement
}

describe('create workspace from the rail-owned dialog', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  async function mount() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <SidebarWorkspacesProvider>
          <SidebarWorkspacesLists />
        </SidebarWorkspacesProvider>,
      )
    })
  }

  it('creates the workspace, shows it in the rail, and navigates into it', async () => {
    const dispose = vi.fn()
    testState.createWorkspace.mockReturnValue({
      getMetadata: async () => ({ id: 'ws-new', title: 'GTM Q3' }),
      [Symbol.dispose]: dispose,
    })

    await mount()
    await act(async () => { openCreateWorkspace() })

    const input = document.body.querySelector<HTMLInputElement>('input[type="text"]')!
    await act(async () => {
      input.value = 'GTM Q3'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttonLabelled('Create').click())

    expect(testState.createWorkspace).toHaveBeenCalledWith('GTM Q3')
    expect(testState.navigate).toHaveBeenCalledWith({
      to: '/workspace/$id',
      params: { id: 'ws-new' },
    })
    // Appears in the rail without a refetch: listGadgets ran once, on mount.
    expect(testState.listGadgets).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain('GTM Q3')
    expect(dispose).toHaveBeenCalled()
  })

  it('reports a failure and leaves the rail unchanged', async () => {
    testState.createWorkspace.mockReturnValue({
      getMetadata: async () => { throw new Error('nope') },
      [Symbol.dispose]: vi.fn(),
    })

    await mount()
    await act(async () => { openCreateWorkspace() })
    await act(async () => buttonLabelled('Create').click())

    expect(testState.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to create workspace' }),
    )
    expect(testState.navigate).not.toHaveBeenCalled()
    expect(container!.textContent).not.toContain('GTM Q3')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @gadgets/workshop-frontend exec vitest run src/createWorkspaceFlow.test.tsx`

Expected: FAIL — cannot resolve `./components/AppShell/createWorkspaceBus`.

- [ ] **Step 3: Create the bus**

Create `packages/workshop-frontend/src/components/AppShell/createWorkspaceBus.ts`:

```ts
// Same decoupling trick as commandPaletteBus: the create-workspace dialog is mounted once inside
// SidebarWorkspacesProvider (the only place that can splice the new workspace into the rail's list
// state), but the button that opens it lives in the /workspaces route, which renders in a sibling
// subtree outside that provider. An event avoids widening the provider to wrap the whole tree.
export const OPEN_CREATE_WORKSPACE_EVENT = 'gadgets:open-create-workspace'

export function openCreateWorkspace(): void {
  window.dispatchEvent(new CustomEvent(OPEN_CREATE_WORKSPACE_EVENT))
}
```

- [ ] **Step 4: Extend the provider**

In `packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx`:

**4a.** Change the router import on line 11 from `import { Link } from '@tanstack/react-router'` to:

```ts
import { Link, useNavigate } from '@tanstack/react-router'
```

**4b.** Add these imports beside the existing ones (after line 28):

```ts
import CreateWorkspaceDialog from '../CreateWorkspaceDialog'
import { OPEN_CREATE_WORKSPACE_EVENT } from './createWorkspaceBus'
```

**4c.** Add to `WorkspacesContextValue` (after `onDelete` on line 52):

```ts
  // Opens the create-workspace dialog. Exposed for completeness; the /workspaces route triggers it
  // through createWorkspaceBus instead, since it renders outside this provider.
  onCreateWorkspace: () => void
```

**4d.** Inside `SidebarWorkspacesProvider`, after the `toasts` line (line 70), add:

```ts
  const navigate = useNavigate()
```

**4e.** After the share/delete dialog state (after line 82), add:

```ts
  // Create dialog state.
  const [createOpen, setCreateOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
```

**4f.** After the `whoami` effect (after line 86), add:

```ts
  // The button lives in the /workspaces route, outside this provider — see createWorkspaceBus.
  useEffect(() => {
    const open = () => setCreateOpen(true)
    window.addEventListener(OPEN_CREATE_WORKSPACE_EVENT, open)
    return () => window.removeEventListener(OPEN_CREATE_WORKSPACE_EVENT, open)
  }, [])
```

**4g.** After `handleDeleteConfirm` (after line 210), add the create handler. It follows `onShare`'s stub idiom exactly — assign the un-awaited call, pipeline a method off it, dispose in `finally`:

```ts
  const handleCreateConfirm = useCallback(async (title: string) => {
    setIsCreating(true)
    let overseer: RpcStub<Overseer> | null = null
    try {
      overseer = authenticatedApi.createWorkspace(title) // pipelining
      const metadata = await overseer.getMetadata()
      // There's no live subscription behind `gadgets`, so splice the new workspace in rather than
      // refetching. `lastActive` must be a real Date: the Favorites/Recent sort dereferences it.
      const now = new Date()
      setGadgets((prev) => [{ ...metadata, created: now, lastActive: now }, ...prev])
      setCreateOpen(false)
      navigate({ to: '/workspace/$id', params: { id: metadata.id } })
    } catch (err) {
      console.error('Failed to create workspace:', err)
      toasts.add({ title: 'Failed to create workspace', variant: 'error' })
    } finally {
      overseer?.[Symbol.dispose]()
      setIsCreating(false)
    }
  }, [authenticatedApi, navigate, toasts])
```

**4h.** Add to the context `value` object (after `onDelete: setDeleteTarget,` on line 222):

```ts
    onCreateWorkspace: () => setCreateOpen(true),
```

**4i.** Render the dialog inside the provider, immediately before `{/* Delete confirm */}` (line 229):

```tsx
      {/* Create workspace */}
      <CreateWorkspaceDialog
        open={createOpen}
        isCreating={isCreating}
        onOpenChange={setCreateOpen}
        onConfirm={handleCreateConfirm}
      />

```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @gadgets/workshop-frontend exec vitest run src/createWorkspaceFlow.test.tsx`

Expected: PASS, 2 tests.

If `overseer = authenticatedApi.createWorkspace(title)` is a type error, do **not** add a cast — compare against `onShare` at [SidebarWorkspaces.tsx:169-182](../../../packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx#L169-L182), which assigns `authenticatedApi.openGadget(...)` to an `RpcStub<Overseer> | null` and compiles today. Match that shape.

- [ ] **Step 6: Repoint the `/workspaces` button**

Replace `packages/workshop-frontend/src/routes/workspaces.tsx` lines 1-31's `Link` with a button. The new imports and header become:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from '@phosphor-icons/react'
import GadgetList from '../components/GadgetList'
import { openCreateWorkspace } from '../components/AppShell/createWorkspaceBus'
import { useDocumentTitle } from '../useDocumentTitle'
```

and, replacing the comment and `<Link>` at lines 23-30:

```tsx
        {/* Opens the name dialog owned by SidebarWorkspacesProvider, which creates the workspace,
            shows it in the rail immediately, and navigates into it. */}
        <button
          type="button"
          onClick={() => openCreateWorkspace()}
          className="press inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover"
        >
          <Plus size={14} weight="bold" />
          Create workspace
        </button>
```

Note `Link` is no longer imported — an unused import is a lint **error**.

- [ ] **Step 7: Verify the whole frontend**

Run: `pnpm --filter @gadgets/workshop-frontend test && pnpm lint`

Expected: PASS. `homePromptFlow.test.tsx` must still pass — Home is deliberately untouched.

- [ ] **Step 8: Manual verification of the full spec**

With `pnpm dev-server` running, walk the spec:
1. Go to `/workspaces`, click `Create workspace` → the dialog opens with the name field focused.
2. Type `GTM Q3`, press Enter → dialog closes.
3. `GTM Q3` appears at the top of **Recent workspaces** in the rail, with no page reload.
4. You are inside `/workspace/<id>`; the header reads `GTM Q3`; the conversation list shows `No conversations yet`; the composer is present.
5. Send a message → a chat is created inside this workspace and the workspace title stays `GTM Q3`.
6. Accept a code change from the agent → the title is still `GTM Q3` (the Task 2 guard).
7. Reload the page → `GTM Q3` is still listed (it was never provisional).
8. Click `Create workspace`, leave the name blank, confirm → a workspace titled `Untitled Workspace` is created and listed.
9. Delete an empty workspace from the rail's row menu → it disappears cleanly.

- [ ] **Step 9: Commit**

```bash
git add packages/workshop-frontend/src/components/AppShell/createWorkspaceBus.ts \
        packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx \
        packages/workshop-frontend/src/routes/workspaces.tsx \
        packages/workshop-frontend/src/createWorkspaceFlow.test.tsx
git commit -m "feat(workspaces): create a named workspace from the workspaces page"
```

- [ ] **Step 10: Final full verification**

Run: `pnpm build && pnpm test && pnpm lint`

Expected: all PASS. Report actual output — do not claim success without it.

---

## Self-Review

**Spec coverage**

| Spec item | Task |
|---|---|
| 1. Button opens a name dialog | 4 (component), 5 (wiring + button) |
| 2. Confirming creates a real empty workspace | 3 (`createWorkspace` + `lastActive` at birth) |
| 3. Appears in Recent immediately, no reload | 5 (Step 4g optimistic splice; asserted in Step 1's test) |
| 4. Navigates into the workspace, chat UI with empty list | 5 (Step 4g `navigate`); empty state already exists at `ChatInterface.tsx:6477-6480` |
| 5. Starting a chat creates it inside the workspace | No change needed — existing `handleNewChatSend` → `overseer.newChat()`; verified in Task 5 Step 8.5 |
| 6. A user-named workspace is never auto-renamed | 2 (`titleChosenByUser` flag latched by `setTitle`, checked by both auto-namers) |
| Non-goal: Home unchanged | No task touches `routes/index.tsx`; `homePromptFlow.test.tsx` is a regression gate (Task 5 Step 7) |
| Non-goal: blank name allowed | 3 (server-side trim + fallback), 4 (test: empty string), 5 (Step 8.8) |

**Known coverage gaps, stated rather than papered over**

- Neither auto-namer has an automated test (both call a real model; the test env has no gateway credentials). Covered by Task 1's exhaustive predicate tests plus Task 2 Step 5, which walks both directions — the Home two-stage rename still firing, and a chosen name surviving.
- `server.ts:createWorkspace`'s cross-DO composition has no fast automated test (the full-stack `__integration__` suite is `describe.skip`-ed for CI timeouts). Covered by Task 5's manual walk, which exercises the same path through the UI.
- Task 5's test mocks `Link` and `useNavigate`. Verified this is sufficient: `SidebarWorkspaces.tsx` uses no other router hooks, and `SidebarGadgetRow`'s `activeProps` is inert against a mocked `Link`. If the test still needs adjustment, fix the mocks — not the component.

**Regressions considered and cleared**

- **Other `isFullyCreated` call sites.** Setting `lastActive` at birth also makes an explicitly-created workspace visible to the outputs backfill sweep ([user.ts:795](../../../packages/workshop-backend/src/user.ts#L795)) and the outputs read path ([user.ts:844](../../../packages/workshop-backend/src/user.ts#L844)). Neither is a correctness problem: an empty workspace has no outputs, so the read path yields nothing and the sweep does one cheap no-op DO open. No action needed.
- **Empty-workspace render.** `ChatInterface`'s auto-select effect is correctly guarded on `chatList.length > 0` ([ChatInterface.tsx:4561-4570](../../../packages/workshop-frontend/src/ChatInterface.tsx#L4561-L4570)) and `currentMessages` returns `[]` when nothing is selected, so `selectedChatId === null` is an anticipated state rather than a crash. The chat pane may nonetheless look bare next to the `No conversations yet` list — Task 5 Step 8.4 is the gate. If it reads as broken rather than merely empty, stop and raise it: adding an empty-state is a design decision, not a patch to slip into this PR.
- **Analytics union widening.** `source` is only ever declared, never switched on, so adding `"named"` cannot break an exhaustive check.
- **Dialog on failure.** `handleCreateConfirm` only calls `setCreateOpen(false)` on success, so a failed create leaves the dialog open with the typed name intact for a retry. Task 5 Step 1's second test asserts no navigation and no rail entry; consider also asserting the dialog is still mounted.

**Type consistency check**

- `isReplaceableWorkspaceTitle` — same name in Task 1 (definition), Task 1 Step 6 (overseer.ts:5177), and Task 2 Step 3 (extended guard). ✓
- `titleChosenByUser` — declared in Task 2 Step 1 (storage default `false`), written in Task 2 Step 2 (`setTitle`), read in Task 2 Step 3 (both auto-namers), inherited by Task 3 Step 7 via `setTitle`. ✓
- `DEFAULT_WORKSPACE_TITLE` — same name in Task 1, Task 1 Step 6 (×2), Task 3 Steps 1 and 7. ✓
- `newGadget(id, title, lastActive?)` — three-arg form used in Task 3 Step 1's test and Step 7's `createWorkspace`; two-arg calls at `server.ts:266` (Task 1 Step 6) stay valid because the parameter is optional. ✓
- `createWorkspace(title?: string)` — declared in Task 3 Step 6, implemented in Step 7, called in Task 5 Step 4g as `createWorkspace(title)` with a string. ✓
- `CreateWorkspaceDialog` props — `open` / `isCreating` / `onOpenChange` / `onConfirm` defined in Task 4 Step 3, exercised identically in Task 4 Step 1 and Task 5 Step 4i. ✓
- `openCreateWorkspace` / `OPEN_CREATE_WORKSPACE_EVENT` — defined in Task 5 Step 3, consumed in Step 4b/4f (event) and Step 6 (function). ✓
