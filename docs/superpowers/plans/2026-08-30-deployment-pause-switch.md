# Deployment Pause Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deployment admin pause and resume the instance from `/admin`, stopping every path that can start an agent turn, while leaving scheduled tasks intact so they resume normally.

**Architecture:** One `paused` flag on `AdminConfig` (owned by the `AdminSettings` DO, mirrored to a reserved KV key that both chokepoints already read). Four gates consume it: `authenticate()`, the gatekeeper login flow, the agent turn, and `startHook()`. The scheduler learns it is paused from a shared error-message constant thrown by `startHook()`, and **releases** the prepared run instead of rejecting it — reverting to the pre-run state so `nextFire` is untouched.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, Cap'n Web RPC, vitest (`@cloudflare/vitest-pool-workers`), React 19 + Kumo UI.

**Spec:** [`../specs/2026-08-30-deployment-pause-switch-design.md`](../specs/2026-08-30-deployment-pause-switch-design.md)

## Global Constraints

- **pnpm only**, never npm. `pnpm lint` (= `lint:check` + `types:scripts` + `types:check`) and `pnpm test` must pass before every commit.
- **`workshop-backend` and `workshop-shared` are the kernel.** Reviewers read every line. Keep diffs minimal; do not restructure surrounding code.
- **Every exported member of the `workshop-shared` public API needs a JSDoc `/** */` comment** — types, consts and functions, not just interfaces. Enforced by the `gadgets/prefer-jsdoc` lint rule.
- Never introduce a hand-written interface mirroring an RPC interface plus an `as unknown as` cast.
- No AI/LLM attribution or `Co-Authored-By` in commit messages.
- Commit after each task. Group commits so `workshop-backend`/`workshop-shared` can be reviewed apart from UI.
- Server-side logging uses `@gadgets/backend-utils/logger` with a concrete `event` name and typed fields. Never log secrets.
- The fork ratchet (`scripts/fork-intent.test.ts`) runs under `pnpm test`. Adding fork behaviour worth defending means a row in `docs/fork-delta.md` **and** an assertion with the same id.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/workshop-shared/src/gatekeeper.ts` | Gatekeeper contract shared by both Workers | Add `HOOK_PAUSED_MESSAGE` + `isHookPausedError()` |
| `packages/workshop-shared/src/api.ts` | RPC API | Add `ServerConfig.paused`, `AdminSettingsView.paused`, `AdminApi.setPaused`, `AUTH_ERROR_CODES.deploymentPaused` |
| `packages/workshop-backend/src/admin-config.ts` | `AdminConfig` type, defaults, parsing | Add `paused` field |
| `packages/workshop-backend/src/admin-settings.ts` | `AdminSettings` DO + `AdminApi` impl | Add `setPaused`, surface `paused` in `getSettings` |
| `packages/workshop-backend/src/deployment-config.ts` | Builds public `ServerConfig` | Surface `paused` |
| `packages/workshop-backend/src/auth/admin.ts` | **New (Task 0).** Sign-in identity normalisation + shared admin check | `normalizeSignInEmail`, `isAdminUser` |
| `packages/workshop-backend/src/server.ts` | `PublicApi` | Use extracted helper; gate `authenticate` + `authenticateFromCfAccess` |
| `packages/workshop-backend/src/auth/login-flow.ts` | Gatekeeper sign-in | Gate non-admin login |
| `packages/workshop-backend/src/overseer.ts` | Overseer DO | Gate `startHook()`; gate `#runAgentTurnWithContext` |
| `packages/gatekeeper-scheduler/src/driver-state.ts` | Schedule state machine | Add `releaseRun()` |
| `packages/gatekeeper-scheduler/src/schedule-driver.ts` | Alarm + delivery | Release on paused; skip `#planAlarm()` |
| `packages/workshop-frontend/src/AdminPage.tsx` | Admin UI | Pause toggle |
| `packages/workshop-frontend/src/LoginPage.tsx` | Sign-in UI | Paused notice |

---

### Task 0: Normalise the sign-in identity (prerequisite)

**Files:**
- Modify: `packages/workshop-backend/src/auth/login-flow.ts:103-121`
- Modify: `packages/workshop-backend/src/server.ts:102-119` (`#isAdmin`), `:765` (`authenticateFromCfAccess`)
- Test: `packages/workshop-backend/__tests__/identity-normalisation.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `packages/workshop-backend/src/auth/admin.ts`, exporting **both** `normalizeSignInEmail(email: string): string` and `isAdminUser(env: Pick<Cloudflare.Env, "ADMINS">, userName: string): boolean`. This task creates the module because its own tests assert case-insensitive admin matching; Task 3 then only rewires `server.ts` to use it.

`isAdminUser` carries the exact parsing semantics of today's `server.ts:#isAdmin()` — including the
`TypeError` on a malformed `ADMINS` — with one deliberate change: both sides are compared through
`normalizeSignInEmail`. Read the original first:

Run: `sed -n '102,119p' packages/workshop-backend/src/server.ts`

**Why this blocks the pause work.** `#isAdmin()` compares the user key to `ADMINS` with an exact,
case-sensitive `admins.includes(name)`, and the verified email is used **verbatim** as the user
Durable Object name in all three entry points. `isEmailAllowed` lowercases only the domain, never the
local part. So an identity provider returning `Pradeep.Mishra@contentstack.com` against
`ADMINS: ["pradeep.mishra@contentstack.com"]` is not recognised as an admin.

Today that is an annoyance — you are signed in but `/admin` is missing, fixable by editing `ADMINS`
and redeploying. **Once pause exists it is a total lockout**: paused plus not-an-admin means denied
at `authenticate()`, for everyone, with only the `wrangler` escape hatch to recover. Pause arms a
latent bug, so the bug is disarmed first.

It also fixes a second, pre-existing defect: mixed-case addresses currently resolve to *different*
Durable Objects, so one person can end up with two accounts and two sets of workspaces.

**This must land before the first deploy.** Durable Object names cannot be renamed, so normalising
later orphans every account created under the old key. The deployment has zero accounts today, which
is the only moment this is free.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { isAdminUser, normalizeSignInEmail } from "../src/auth/admin.js";

describe("normalizeSignInEmail", () => {
  it("lowercases the whole address, so one person is one account", () => {
    expect(normalizeSignInEmail("Pradeep.Mishra@Contentstack.com"))
      .toBe("pradeep.mishra@contentstack.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSignInEmail("  a@b.com  ")).toBe("a@b.com");
  });

  it("leaves an already-normal address untouched", () => {
    expect(normalizeSignInEmail("a@b.com")).toBe("a@b.com");
  });
});

describe("isAdminUser is case-insensitive", () => {
  // The lockout: a provider returning mixed case must still match a lowercase ADMINS entry.
  it("matches regardless of the case either side is written in", () => {
    expect(isAdminUser({ ADMINS: ["pradeep.mishra@contentstack.com"] },
        "Pradeep.Mishra@Contentstack.com")).toBe(true);
    expect(isAdminUser({ ADMINS: ["Pradeep.Mishra@Contentstack.com"] },
        "pradeep.mishra@contentstack.com")).toBe(true);
  });

  it("still rejects a genuinely different address", () => {
    expect(isAdminUser({ ADMINS: ["a@example.com"] }, "b@example.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/identity-normalisation.test.ts`
Expected: FAIL — `normalizeSignInEmail` is not exported, and the case-insensitive admin assertions fail.

- [ ] **Step 3: Implement**

In `auth/admin.ts`:

```ts
/**
 * The canonical form of a verified email, used as the user Durable Object's name.
 *
 * Applied at every point an identity provider's address enters the system, so one person is one
 * account however their provider capitalises the claim, and so the `ADMINS` comparison cannot miss.
 * Durable Object names cannot be renamed, so this must be settled before a deployment has accounts.
 */
export function normalizeSignInEmail(email: string): string {
  return email.trim().toLowerCase();
}
```

Make `isAdminUser` compare `normalizeSignInEmail` on both sides. Then apply it at every entry point:
`login-flow.ts` before `idFromName(email)` **and** before the `loginOrCreateViaGatekeeper` call and
the `pending.deliver(\`${email}:${secret}\`)` token prefix, so the token the browser stores already
carries the canonical name; and `server.ts:765` in `authenticateFromCfAccess`.

Leave `authenticate(token)` resolving `split[0]` **as given** — the prefix is whatever login minted,
which is now already canonical. Normalising there too would break any token minted before this task.

- [ ] **Step 4: Run to verify it passes, and that sign-in still works end to end**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run`
Expected: PASS

Run: `pnpm run-local`, sign in, confirm `/admin` is reachable for the configured admin.

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-backend/src/auth packages/workshop-backend/src/server.ts packages/workshop-backend/__tests__/identity-normalisation.test.ts
git commit -m "fix(auth): normalise the sign-in identity so one person is one account"
```

---

### Task 1: `paused` on `AdminConfig`

**Files:**
- Modify: `packages/workshop-backend/src/admin-config.ts`
- Test: `packages/workshop-backend/__tests__/admin-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AdminConfig.paused: boolean`, defaulting to `false` in both `DEFAULT_ADMIN_CONFIG` and `parseAdminConfig`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/workshop-backend/__tests__/admin-config.test.ts` (create the file if absent, matching the imports of a sibling test):

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG, parseAdminConfig } from "../src/admin-config.js";

describe("paused", () => {
  it("defaults to false", () => {
    expect(DEFAULT_ADMIN_CONFIG.paused).toBe(false);
  });

  // Every config stored before this field existed lacks the key. Defaulting it to anything but
  // false would pause a running deployment on deploy.
  it("defaults to false when the stored config predates the field", () => {
    expect(parseAdminConfig(JSON.stringify({ signupsEnabled: true })).paused).toBe(false);
  });

  it("round-trips true", () => {
    expect(parseAdminConfig(JSON.stringify({ paused: true })).paused).toBe(true);
  });

  // A non-boolean must not be coerced: `parseAdminConfig` reads untrusted stored JSON, and
  // `"false"` is truthy.
  it("ignores a non-boolean", () => {
    expect(parseAdminConfig(JSON.stringify({ paused: "false" })).paused).toBe(false);
    expect(parseAdminConfig(JSON.stringify({ paused: 1 })).paused).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/admin-config.test.ts`
Expected: FAIL — `paused` is `undefined`.

- [ ] **Step 3: Implement**

In `admin-config.ts`, add to the `AdminConfig` type after `signupsEnabled`:

```ts
  /**
   * Whether the deployment is paused. While paused only admins may sign in or work, and scheduled
   * tasks drop the occurrence they were due for without altering the schedule. A cost circuit
   * breaker, not an authentication setting: it only ever narrows access.
   */
  paused: boolean;
```

Add to `DEFAULT_ADMIN_CONFIG`: `paused: false,`

Add to the object returned by `parseAdminConfig`:

```ts
      paused: p.paused === true,
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/admin-config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-backend/src/admin-config.ts packages/workshop-backend/__tests__/admin-config.test.ts
git commit -m "feat(admin): add a paused flag to AdminConfig"
```

---

### Task 2: Shared paused-hook signal

**Files:**
- Modify: `packages/workshop-shared/src/gatekeeper.ts`
- Test: `packages/workshop-shared/__tests__/gatekeeper-paused.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `HOOK_PAUSED_MESSAGE: string` and `isHookPausedError(err: unknown): boolean`, both exported from `@gadgets/workshop-shared/gatekeeper`.

Both Workers already depend on this package, so it is the one place the two sides of the RPC boundary can agree on a string without drifting.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { HOOK_PAUSED_MESSAGE, isHookPausedError } from "../src/gatekeeper.js";

describe("isHookPausedError", () => {
  it("recognises an Error carrying the shared message", () => {
    expect(isHookPausedError(new Error(HOOK_PAUSED_MESSAGE))).toBe(true);
  });

  // Worker RPC may deliver the failure as a plain object or a bare string rather than an Error.
  it("recognises the message on a non-Error value", () => {
    expect(isHookPausedError({ message: HOOK_PAUSED_MESSAGE })).toBe(true);
    expect(isHookPausedError(HOOK_PAUSED_MESSAGE)).toBe(true);
  });

  // RPC frequently prefixes the remote message. Substring matching keeps the signal alive.
  it("recognises a wrapped message", () => {
    expect(isHookPausedError(new Error(`remote error: ${HOOK_PAUSED_MESSAGE}`))).toBe(true);
  });

  // Everything else must keep today's settle-the-schedule behaviour.
  it("rejects unrelated failures", () => {
    expect(isHookPausedError(new Error("Hook has been deleted or disabled."))).toBe(false);
    expect(isHookPausedError(new Error("Gatekeeper is disabled."))).toBe(false);
    expect(isHookPausedError(undefined)).toBe(false);
    expect(isHookPausedError(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-shared exec vitest run __tests__/gatekeeper-paused.test.ts`
Expected: FAIL — module has no export `HOOK_PAUSED_MESSAGE`.

- [ ] **Step 3: Implement**

Append to `packages/workshop-shared/src/gatekeeper.ts`:

```ts
/**
 * The exact message `startHook()` throws while the deployment is paused.
 *
 * A gatekeeper must be able to tell "paused, try again later" from "this hook is gone", because the
 * two demand opposite handling: the first releases the occurrence unchanged, the second settles the
 * schedule. Custom error properties do not reliably survive a Worker-to-Worker RPC boundary, so the
 * message is the carrier and this constant is the single definition both sides compile against.
 */
export const HOOK_PAUSED_MESSAGE = "Deployment is paused; hook delivery is suspended.";

/**
 * Whether `err` is the paused-hook refusal, tolerating however RPC delivered it — an `Error`, a
 * plain object with a `message`, a bare string, and any remote prefix wrapped around it.
 *
 * Deliberately narrow: anything it does not recognise keeps the caller's existing behaviour, so a
 * signal that stops propagating degrades to what the code did before rather than to something worse.
 */
export function isHookPausedError(err: unknown): boolean {
  const message =
    typeof err === "string" ? err
    : err instanceof Error ? err.message
    : typeof (err as { message?: unknown })?.message === "string"
      ? (err as { message: string }).message
      : "";
  return message.includes(HOOK_PAUSED_MESSAGE);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @gadgets/workshop-shared exec vitest run __tests__/gatekeeper-paused.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-shared/src/gatekeeper.ts packages/workshop-shared/__tests__/gatekeeper-paused.test.ts
git commit -m "feat(shared): add the paused-hook signal both workers agree on"
```

---

### Task 3: Extract the admin-identity check

**Files:**
- Modify: `packages/workshop-backend/src/server.ts:102-119` (`#isAdmin`)
- Test: `packages/workshop-backend/__tests__/auth-admin.test.ts` (create)

**Interfaces:**
- Consumes: `isAdminUser` and `normalizeSignInEmail` from `auth/admin.ts` (Task 0).
- Produces: nothing new. `#isAdmin()` and all its call sites keep their current signatures.

`#isAdmin()` is private to `PublicApiImpl`, but Task 7 needs the same check from the login flow. Task 0 already created the shared helper; this task points `server.ts` at it so there is exactly one copy of the `ADMINS` parsing.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { isAdminUser } from "../src/auth/admin.js";

describe("isAdminUser", () => {
  it("accepts a listed admin from a JSON binding array", () => {
    expect(isAdminUser({ ADMINS: ["a@example.com"] }, "a@example.com")).toBe(true);
  });

  it("accepts a listed admin from a JSON string, which is what a secret binding carries", () => {
    expect(isAdminUser({ ADMINS: '["a@example.com"]' }, "a@example.com")).toBe(true);
  });

  it("rejects an unlisted user", () => {
    expect(isAdminUser({ ADMINS: ["a@example.com"] }, "b@example.com")).toBe(false);
  });

  it("rejects when ADMINS is unset", () => {
    expect(isAdminUser({}, "a@example.com")).toBe(false);
  });

  // Preserved from #isAdmin: a malformed ADMINS is a deployment error, not a silent allow.
  it("throws on a malformed ADMINS", () => {
    expect(() => isAdminUser({ ADMINS: "not-json" }, "a@example.com")).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/auth-admin.test.ts`
Expected: FAIL — cannot resolve `../src/auth/admin.js`.

- [ ] **Step 3: Implement**

Replace the body of `server.ts:#isAdmin()` with a call to it, keeping the method and every call site (`server.ts:644`, `650`, `654`) unchanged.

- [ ] **Step 4: Run to verify it passes, and that nothing regressed**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run` — all backend tests
Expected: PASS, with no change in count other than the 5 added.

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-backend/src/server.ts packages/workshop-backend/__tests__/auth-admin.test.ts
git commit -m "refactor(auth): extract the admin-identity check for reuse"
```

---

### Task 4: `startHook()` refuses while paused

**Files:**
- Modify: `packages/workshop-backend/src/overseer.ts:6933-6953`
- Test: `packages/workshop-backend/__tests__/overseer-paused-hook.test.ts` (create)

**Interfaces:**
- Consumes: `AdminConfig.paused` (Task 1), `HOOK_PAUSED_MESSAGE` (Task 2).
- Produces: `startHook()` throws `new Error(HOOK_PAUSED_MESSAGE)` while paused, before returning any capability.

`startHook()` already calls `readAdminConfig(this.env)` to reject disabled gatekeepers, so the flag is free on this path.

> **This gate is not scheduler-specific — it refuses every hook in the deployment.** The other
> consumer is `gatekeeper-email`, which has no failure handling at all
> ([`email.ts:672`](../../../packages/gatekeeper-email/src/email.ts#L672)): the throw propagates out
> of `receiveEmail()` and fails the Email Worker handler, so **mail arriving while paused is
> rejected or bounced, not queued**. That is accepted, not fixed — Email Routing needs a zone, so
> `gatekeeper-email` is `NOT_INSTALLABLE` here and is not deployed. Task 11 documents it. Do not add
> a retry queue as a rider on this task.

- [ ] **Step 1: Write the failing test**

Follow the setup of an existing overseer test for constructing the DO and seeding the admin-config KV key. Assert:

```ts
it("refuses to start a hook while the deployment is paused", async () => {
  await seedAdminConfig({ paused: true });
  await expect(startHookUnderTest()).rejects.toThrow(HOOK_PAUSED_MESSAGE);
});

it("starts hooks normally when not paused", async () => {
  await seedAdminConfig({ paused: false });
  await expect(startHookUnderTest()).resolves.toBeDefined();
});

// The paused check must precede capability construction: a returned ApprovalQueue is a live
// session the gatekeeper could still use.
it("returns no capability while paused", async () => {
  await seedAdminConfig({ paused: true });
  const result = await startHookUnderTest().catch(() => undefined);
  expect(result).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/overseer-paused-hook.test.ts`
Expected: FAIL — the hook starts while paused.

- [ ] **Step 3: Implement**

In `overseer.ts:startHook()`, immediately after `let config = await readAdminConfig(this.env);` and **before** the `disabledGatekeepers` check:

```ts
    // Paused deployments deliver no hooks. Thrown rather than returned so the gatekeeper's existing
    // failure path handles it, and thrown with the shared message so the scheduler can tell this
    // apart from a hook that is genuinely gone -- see HOOK_PAUSED_MESSAGE.
    if (config.paused) throw new Error(HOOK_PAUSED_MESSAGE);
```

Import `HOOK_PAUSED_MESSAGE` from `@gadgets/workshop-shared/gatekeeper`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/overseer-paused-hook.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Verify the message survives the RPC boundary**

This is the assumption the whole scheduler design rests on, and a mock `HookInitiator` cannot test it — it proves nothing about serialization across Workers.

First check the harness can express it at all: `packages/integration-tests/src/` contains only `harness.ts`, `network-interceptor.ts` and `rpc-client.ts`, and whether it can stand up a gatekeeper calling into a paused backend is **unverified**.

Run: `grep -n "export" packages/integration-tests/src/harness.ts | head -30`

- **If the harness supports it:** add a case that starts a hook through a real cross-Worker `HookInitiator` stub against a paused deployment and asserts `isHookPausedError(caught) === true`. Run `pnpm --filter @gadgets/integration-tests test`.
- **If it does not:** do **not** build a new harness here. Instead verify manually against the local stack — `pnpm run-local`, pause via `/admin`, register a scheduled task, and confirm the driver logs `scheduler.alarm.paused` rather than a delivery failure — and record the result in the task's commit message.

**If the message does not survive**, stop and report before starting Task 6, which depends on this signal. The fallback is to widen `isHookPausedError` to match whatever the boundary actually delivers — never to drop the distinction, because without it Finding 1 returns and one-time schedules expire.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-backend/src/overseer.ts packages/workshop-backend/__tests__/overseer-paused-hook.test.ts packages/integration-tests
git commit -m "feat(overseer): refuse hook delivery while the deployment is paused"
```

---

### Task 5: `releaseRun()` — revert a prepared run without settling it

**Files:**
- Modify: `packages/gatekeeper-scheduler/src/driver-state.ts`
- Test: `packages/gatekeeper-scheduler/__tests__/driver-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `releaseRun(schedule: EnabledSchedule, runId: string, scheduledTime: number): EnabledSchedule` — the inverse of `beginDueRun`.

This is the fix for the Finding-1 regression. `rejectRun` expires a `once` schedule; `releaseRun` must leave both kinds exactly as they were.

- [ ] **Step 1: Write the failing tests**

Add to `driver-state.test.ts`, following the existing fixture helpers in that file:

```ts
describe("releaseRun", () => {
  // The whole point: a one-time schedule must survive a pause. rejectRun expires it.
  it("returns a once schedule to active with its original nextFire", () => {
    const active = onceSchedule({ nextFire: 1_000 });
    const pending = beginDueRun(active, 1_000, "run-1", 6_000);
    const released = releaseRun(pending, "run-1", 1_000);
    expect(released.status).toBe("active");
    expect(released.nextFire).toBe(1_000);
    expect(released.spec.kind).toBe("once");
  });

  it("returns a recurring schedule to active without advancing it", () => {
    const active = recurringSchedule({ nextFire: 1_000 });
    const pending = beginDueRun(active, 1_000, "run-1", 6_000);
    const released = releaseRun(pending, "run-1", 1_000);
    expect(released.status).toBe("active");
    expect(released.nextFire).toBe(1_000);
  });

  // Attempts count real delivery attempts. A pause is not one.
  it("does not consume an attempt", () => {
    const pending = beginDueRun(recurringSchedule({ nextFire: 1_000 }), 1_000, "run-1", 6_000);
    expect(releaseRun(pending, "run-1", 1_000).attempts).toBe(pending.attempts);
  });

  // Same guard as rejectRun: a stale runId must not disturb a newer run.
  it("ignores a runId that is not the pending admission", () => {
    const pending = beginDueRun(recurringSchedule({ nextFire: 1_000 }), 1_000, "run-1", 6_000);
    expect(releaseRun(pending, "other-run", 1_000)).toBe(pending);
  });

  it("ignores a schedule that is past admission", () => {
    const admitted = admitRun(
      beginDueRun(recurringSchedule({ nextFire: 1_000 }), 1_000, "run-1", 6_000),
      "run-1", 2_000, 7_000);
    expect(releaseRun(admitted, "run-1", 1_000)).toBe(admitted);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/gatekeeper-scheduler exec vitest run __tests__/driver-state.test.ts`
Expected: FAIL — `releaseRun` is not exported.

- [ ] **Step 3: Implement**

Add to `driver-state.ts`, directly after `rejectRun`:

```ts
/**
 * Undo a prepared-but-undelivered run, returning the schedule to `active` at the occurrence it was
 * already due for.
 *
 * The inverse of {@link beginDueRun}, and deliberately not {@link rejectRun}: rejecting *settles*
 * the occurrence, which expires a `once` schedule outright and advances a recurring one. Releasing
 * is for the case where the attempt never happened at all — the deployment is paused — so the
 * schedule must look untouched and come due again unchanged.
 *
 * Guarded like `rejectRun`: only the run that is pending admission under `runId` is released, so a
 * stale caller cannot disturb a newer run.
 */
export function releaseRun(
  schedule: EnabledSchedule,
  runId: string,
  scheduledTime: number,
): EnabledSchedule {
  if (!isPending(schedule, runId, "admission")) return schedule;
  return { ...copyProgress(schedule), status: "active", nextFire: scheduledTime };
}
```

Confirm against the `EnabledSchedule` union that `{...copyProgress(schedule), status: "active", nextFire}` type-checks; if `copyProgress` carries fields invalid on an active schedule, mirror exactly what `rejectRun`'s `{ ...common, status: "active", nextFire }` branch does.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @gadgets/gatekeeper-scheduler exec vitest run __tests__/driver-state.test.ts`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add packages/gatekeeper-scheduler/src/driver-state.ts packages/gatekeeper-scheduler/__tests__/driver-state.test.ts
git commit -m "feat(scheduler): add releaseRun to revert a run without settling the schedule"
```

---

### Task 6: Driver releases and backs off while paused

**Files:**
- Modify: `packages/gatekeeper-scheduler/src/schedule-driver.ts` (`#runAlarm`, `#deliverPrepared`, new `#releasePending`)
- Test: `packages/gatekeeper-scheduler/__tests__/schedule-driver.test.ts`

**Interfaces:**
- Consumes: `releaseRun` (Task 5), `isHookPausedError` (Task 2).
- Produces: `type DeliveryOutcome = "delivered" | "rejected" | "paused"`; `#deliverPrepared`, `#deliver` and `#deliverSafely` all return it. `#runAlarm` returns `{ ..., pausedCount: number }` and, when `pausedCount > 0`, returns **before** `#planAlarm()`.

Fixes Finding 2: released schedules stay due, so pulling the alarm forward would spin.

> **Do not signal this by throwing.** An earlier draft threw a sentinel from `#deliverPrepared` and
> caught it in `#deliverSafely` — but `#deliver` sits between them and catches everything first
> ([`schedule-driver.ts:380-385`](../../../packages/gatekeeper-scheduler/src/schedule-driver.ts#L380-L385)),
> so the sentinel would be swallowed, reported as a delivery failure, and `pausedCount` would stay
> zero — leaving the hot-loop unfixed and adding an error report per schedule per alarm. A returned
> value cannot be intercepted by a `catch`, which is the whole point.

- [ ] **Step 1: Write the failing tests**

The existing test file mocks `HookInitiator`, so make `startHook()` reject with `new Error(HOOK_PAUSED_MESSAGE)`.

```ts
describe("paused deployment", () => {
  it("leaves a once schedule due instead of expiring it", async () => {
    const driver = await seedDriver({ spec: { kind: "once" }, nextFire: NOW });
    hooks.startHook.mockRejectedValue(new Error(HOOK_PAUSED_MESSAGE));
    await runDurableObjectAlarm(driver);
    const stored = await readSchedule(driver);
    expect(stored.state.status).toBe("active");
    expect(stored.state.nextFire).toBe(NOW);
  });

  it("delivers that same schedule once after resume, not once per missed alarm", async () => {
    const driver = await seedDriver({ spec: { kind: "once" }, nextFire: NOW });
    hooks.startHook.mockRejectedValue(new Error(HOOK_PAUSED_MESSAGE));
    await runDurableObjectAlarm(driver);
    await runDurableObjectAlarm(driver);
    hooks.startHook.mockResolvedValue(hookResult());
    await runDurableObjectAlarm(driver);
    expect(hooks.startHook).toHaveBeenCalledTimes(3);
    expect(deliveries).toHaveLength(1);
  });

  // Finding 2: releasing leaves nextFire in the past, so planAlarm would schedule ~now and spin.
  it("keeps the 5-minute recovery alarm rather than re-firing immediately", async () => {
    const driver = await seedDriver({ spec: { kind: "recurring" }, nextFire: NOW });
    hooks.startHook.mockRejectedValue(new Error(HOOK_PAUSED_MESSAGE));
    await runDurableObjectAlarm(driver);
    expect(await getAlarm(driver)).toBeGreaterThanOrEqual(NOW + 5 * 60_000);
  });

  // Recurring schedules must not accumulate: a long pause spanning many occurrences still
  // delivers once on resume, then returns to normal cadence.
  it("delivers a recurring schedule once after a long pause, then resumes cadence", async () => {
    const driver = await seedDriver({ spec: { kind: "recurring", everyMs: 60_000 }, nextFire: NOW });
    hooks.startHook.mockRejectedValue(new Error(HOOK_PAUSED_MESSAGE));
    for (let i = 0; i < 5; i++) await runDurableObjectAlarm(driver);
    expect(deliveries).toHaveLength(0);

    hooks.startHook.mockResolvedValue(hookResult());
    await runDurableObjectAlarm(driver);
    expect(deliveries).toHaveLength(1);
    const stored = await readSchedule(driver);
    expect(stored.state.status).toBe("active");
    expect(stored.state.nextFire).toBeGreaterThan(NOW);
  });

  // Regression guard: unrecognised failures must keep settling exactly as before.
  it("still expires a once schedule when the hook is genuinely gone", async () => {
    const driver = await seedDriver({ spec: { kind: "once" }, nextFire: NOW });
    hooks.startHook.mockRejectedValue(new Error("Hook has been deleted or disabled."));
    await runDurableObjectAlarm(driver);
    expect((await readSchedule(driver)).state.status).toBe("expired");
  });

  // The admission guard means a run already past admission finishes rather than being reverted.
  it("lets a run already past admission complete", async () => {
    const driver = await seedDriver({ spec: { kind: "recurring" }, nextFire: NOW });
    hooks.startHook.mockResolvedValue(hookResult());
    hooks.authorizeObservation.mockRejectedValue(new Error(HOOK_PAUSED_MESSAGE));
    await runDurableObjectAlarm(driver);
    // Past admission: settled by the normal failure path, not released.
    expect((await readSchedule(driver)).state.status).not.toBe("active");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/gatekeeper-scheduler exec vitest run __tests__/schedule-driver.test.ts`
Expected: FAIL — the once schedule is `expired`, and the alarm is pulled forward.

- [ ] **Step 3a: Verify `#settle` before reusing it**

Run: `grep -n "#settle(prepared" -A 25 packages/gatekeeper-scheduler/src/schedule-driver.ts`

`#releasePending` reuses `#settle` by analogy with `#rejectPending`. Read its body and confirm it is
generic — that it applies the supplied state transition and does nothing reject-specific (clearing
capability records, emitting a settled event, advancing a cursor). **If it does anything beyond
applying the transition and persisting, do not reuse it**: write `#releasePending` as its own
`transactionSync` that reads the schedule, applies `releaseRun`, and puts it back.

- [ ] **Step 3b: Implement**

Add the release helper beside `#rejectPending` (assuming Step 3a cleared `#settle`):

```ts
  #releasePending(prepared: PreparedRun): void {
    this.#settle(prepared, undefined,
        (state) => releaseRun(state, prepared.runId, prepared.scheduledTime));
  }
```

Introduce the outcome type near the top of the module:

```ts
/**
 * What one delivery attempt did. `paused` is distinct from `rejected` because the attempt never
 * happened: the occurrence was released unchanged and the alarm must back off rather than retry.
 */
type DeliveryOutcome = "delivered" | "rejected" | "paused";
```

Change `#deliverPrepared`, `#deliver` and `#deliverSafely` to return `DeliveryOutcome` instead of
`boolean`, mapping today's `true` to `"rejected"` and `false` to `"delivered"`. In
`#deliverPrepared`, replace the admission catch:

```ts
      } catch (error) {
        // A paused deployment is not a refusal of this hook -- the attempt never happened. Release
        // the occurrence unchanged so it is still due, and let the caller back the alarm off.
        if (isHookPausedError(error)) {
          this.#releasePending(prepared);
          return "paused";
        }
        this.#rejectPending(prepared, Date.now());
        return "rejected";
      }
```

`#deliver`'s existing `catch` must keep returning `"rejected"` — a genuine throw is still a failure.
`#deliverSafely` likewise. Because `"paused"` is *returned*, no intermediate `catch` can intercept it.

In `#runAlarm`, count the paused outcomes from `runBounded`, and when the count is non-zero return
**before** `await this.#planAlarm()`, leaving the recovery alarm set on entry (`now + RECOVERY_DELAY_MS`)
in place. Log once per batch, not per schedule:

```ts
      logger.info("scheduler alarm skipped: deployment paused", {
        event: "scheduler.alarm.paused", pausedCount,
      });
```

Add `pausedCount` to `#runAlarm`'s return type and to the existing `scheduler.alarm.completed` debug
fields, so a paused instance is visible in logs without a code change.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @gadgets/gatekeeper-scheduler exec vitest run`
Expected: PASS, including every pre-existing scheduler test.

- [ ] **Step 5: Commit**

```bash
git add packages/gatekeeper-scheduler/src/schedule-driver.ts packages/gatekeeper-scheduler/__tests__/schedule-driver.test.ts
git commit -m "feat(scheduler): drop occurrences while paused without touching the schedule"
```

---

### Task 7: Block non-admin access

**Files:**
- Modify: `packages/workshop-backend/src/server.ts` (`authenticate`, `authenticateFromCfAccess`)
- Modify: `packages/workshop-backend/src/auth/login-flow.ts:113` area
- Modify: `packages/workshop-shared/src/api.ts` (`AUTH_ERROR_CODES`, `AUTH_ERROR_MESSAGES`)
- Test: `packages/workshop-backend/__tests__/paused-access.test.ts` (create)

**Interfaces:**
- Consumes: `isAdminUser` (Task 3), `AdminConfig.paused` (Task 1).
- Produces: `AUTH_ERROR_CODES.deploymentPaused = "DEPLOYMENT_PAUSED"`, and a matching `AUTH_ERROR_MESSAGES` entry.

- [ ] **Step 1: Write the failing tests**

```ts
it("rejects a non-admin session while paused", async () => {
  await seedAdminConfig({ paused: true });
  await expect(publicApi.authenticate(nonAdminToken)).rejects.toThrow(/paused/i);
});

it("admits an admin while paused", async () => {
  await seedAdminConfig({ paused: true });
  await expect(publicApi.authenticate(adminToken)).resolves.toBeDefined();
});

it("admits everyone once resumed", async () => {
  await seedAdminConfig({ paused: false });
  await expect(publicApi.authenticate(nonAdminToken)).resolves.toBeDefined();
});

// Finding 4: a malformed ADMINS must not become an open door.
it("denies a non-admin when the admin check throws", async () => {
  await seedAdminConfig({ paused: true });
  await expect(publicApiWith({ ADMINS: "not-json" }).authenticate(nonAdminToken)).rejects.toThrow();
});

it("refuses gatekeeper sign-in for a non-admin while paused", async () => {
  await seedAdminConfig({ paused: true });
  await expect(completeGatekeeperLogin("user@contentstack.com")).rejects.toThrow(/paused/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/paused-access.test.ts`
Expected: FAIL — non-admins are admitted.

- [ ] **Step 3: Implement**

In `api.ts` add the code, its `AUTH_ERROR_MESSAGES` entry, and a doc comment on the new code member.

In `server.ts:authenticate()`, after the user id is resolved and before returning `AuthenticatedApiImpl`, deny when `(await readAdminConfig(this.env)).paused` and the user is not an admin. Wrap the admin check so a thrown `TypeError` denies rather than propagates as a 500. Apply the same gate in `authenticateFromCfAccess()`.

In `login-flow.ts`, after the existing `isEmailAllowed` check and before `loginOrCreateViaGatekeeper`, fail the pending login with the paused message for a non-admin email. Placing it here means a rejected sign-in leaves no account behind, exactly as the domain check does.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-shared/src/api.ts packages/workshop-backend/src/server.ts packages/workshop-backend/src/auth/login-flow.ts packages/workshop-backend/__tests__/paused-access.test.ts
git commit -m "feat(auth): restrict a paused deployment to admins"
```

---

### Task 8: Block agent turns

**Files:**
- Modify: `packages/workshop-backend/src/overseer.ts:4100-4118`
- Test: `packages/workshop-backend/__tests__/overseer-paused-turn.test.ts` (create)

**Interfaces:**
- Consumes: `AdminConfig.paused` (Task 1).
- Produces: nothing new; `#runAgentTurnWithContext` returns early while paused.

This closes the live-session leak: a WebSocket authenticated before the pause stays authenticated until it reconnects.

- [ ] **Step 1: Write the failing tests**

```ts
it("does not start a turn while paused", async () => {
  await seedAdminConfig({ paused: true });
  await runAgentTurn();
  expect(modelCalls).toHaveLength(0);
});

// Must not leave the UI spinning: the existing finally clears active-agent state.
it("posts an error message and clears the active agent", async () => {
  await seedAdminConfig({ paused: true });
  await runAgentTurn();
  expect(postedErrors.at(-1)).toMatchObject({ kind: "paused" });
  expect(await activeAgent()).toBeUndefined();
});

// Pause exists to stop spend; a continuation is spend.
it("blocks callback-initiated continuations too", async () => {
  await seedAdminConfig({ paused: true });
  await runAgentTurn({ callbackInitiated: true });
  expect(modelCalls).toHaveLength(0);
});

it("runs normally once resumed", async () => {
  await seedAdminConfig({ paused: false });
  await runAgentTurn();
  expect(modelCalls).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/overseer-paused-turn.test.ts`
Expected: FAIL — the turn runs.

- [ ] **Step 3: Implement**

Inside the existing `try` of `#runAgentTurnWithContext`, immediately after `await this.reconcilePendingGadgets(chatId);` and before the usage-limit block, mirroring that block's shape:

```ts
      // A paused deployment runs no turns at all -- including callback-initiated continuations,
      // which the usage limit exempts. Inside the try so the `finally` still clears the active-agent
      // state and emits a stream "clear"; otherwise the UI spins forever on a block.
      if ((await readAdminConfig(this.env)).paused) {
        this.postAgentErrorMessage(chatId, aiModel.profile,
            "This deployment is paused. Ask an administrator to resume it.", "paused");
        turnLogger.debug("agent run finished", {
          event: "agent.run.finished", outcome: "paused",
          durationMs: Date.now() - startedAt,
        });
        return;
      }
```

No shared-type change is needed: `postAgentErrorMessage(chatId, author, message, code?: string)` ([`overseer.ts:5335`](../../../packages/workshop-backend/src/overseer.ts#L5335)) takes an open `string`, so `"paused"` is accepted as-is.

**No admin exemption.** This gate deliberately blocks admins too — see the spec's opening section.
An admin verifying a paused instance signs in and inspects; they do not exercise the agent. Do not
add an initiator-admin check here: the Overseer DO is workspace-scoped and a turn's initiator is not
necessarily the owner, so "is this an admin's turn" is not a question it can answer cheaply or
correctly.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-backend/src/overseer.ts packages/workshop-backend/__tests__/overseer-paused-turn.test.ts
git commit -m "feat(overseer): run no agent turns while the deployment is paused"
```

---

### Task 9: Expose and control `paused` over RPC

**Files:**
- Modify: `packages/workshop-shared/src/api.ts` (`ServerConfig`, `AdminSettingsView`, `AdminApi`)
- Modify: `packages/workshop-backend/src/deployment-config.ts:52`
- Modify: `packages/workshop-backend/src/admin-settings.ts:310-323`, and beside `setSignupsEnabled` (~line 577)
- Test: `packages/workshop-backend/__tests__/admin-settings.test.ts`

**Interfaces:**
- Consumes: `AdminConfig.paused` (Task 1).
- Produces: `ServerConfig.paused: boolean`, `AdminSettingsView.paused: boolean`, `AdminApi.setPaused(paused: boolean): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("reports paused in the settings view", async () => {
  await admin.setPaused(true);
  expect((await admin.getSettings()).paused).toBe(true);
});

it("resumes", async () => {
  await admin.setPaused(true);
  await admin.setPaused(false);
  expect((await admin.getSettings()).paused).toBe(false);
});

// The login page needs it before anyone authenticates.
it("reports paused in the unauthenticated server config", async () => {
  await admin.setPaused(true);
  expect((await getServerConfig(env)).paused).toBe(true);
});

// Pausing must not disturb unrelated settings.
it("leaves other settings untouched", async () => {
  await admin.setSiteName("Acme");
  await admin.setPaused(true);
  expect((await admin.getSettings()).siteName).toBe("Acme");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/admin-settings.test.ts`
Expected: FAIL — `setPaused` is not a function.

- [ ] **Step 3: Implement**

`api.ts` — add to `ServerConfig`:

```ts
  /**
   * Whether the deployment is paused. While paused only admins may sign in; the client shows a
   * notice rather than a broken app.
   */
  paused: boolean;
```

Add the same field to `AdminSettingsView`, and to `AdminApi`:

```ts
  /**
   * Pause or resume the deployment. While paused only admins may sign in or work, and scheduled
   * tasks drop the occurrence they were due for without altering the schedule. Takes up to a minute
   * to apply everywhere, because it is read through the admin-config KV mirror.
   */
  setPaused(paused: boolean): Promise<void>;
```

`deployment-config.ts` — add `paused: config.paused,` to the returned object.
`admin-settings.ts` — add `paused: config.paused,` to `getSettings`, and beside `setSignupsEnabled`:

```ts
  async setPaused(paused: boolean): Promise<void> {
    await this.admin.updateAdminConfig({ paused });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm lint && pnpm --filter @gadgets/workshop-backend exec vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-shared/src/api.ts packages/workshop-backend/src/deployment-config.ts packages/workshop-backend/src/admin-settings.ts packages/workshop-backend/__tests__/admin-settings.test.ts
git commit -m "feat(admin): expose pause over the admin API and server config"
```

---

### Task 10: Admin toggle and paused notice

**Files:**
- Modify: `packages/workshop-frontend/src/AdminPage.tsx`
- Modify: `packages/workshop-frontend/src/LoginPage.tsx`
- Test: `packages/workshop-frontend/src/AdminPage.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `AdminApi.setPaused`, `AdminSettingsView.paused`, `ServerConfig.paused` (Task 9).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```tsx
it("calls setPaused when the admin pauses the deployment", async () => {
  const setPaused = vi.fn();
  render(<AdminPage api={fakeAdminApi({ paused: false, setPaused })} />);
  await userEvent.click(screen.getByRole("button", { name: /pause deployment/i }));
  await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
  expect(setPaused).toHaveBeenCalledWith(true);
});

it("offers resume when already paused", async () => {
  render(<AdminPage api={fakeAdminApi({ paused: true })} />);
  expect(screen.getByRole("button", { name: /resume deployment/i })).toBeInTheDocument();
});

// Finding 0: getSettings reads the DO's own copy, enforcement reads the KV mirror. Claiming
// "paused" off the DO would tell the admin spend had stopped while it had not.
it("shows applying until the server config mirror agrees", async () => {
  const getServerConfig = vi.fn()
    .mockResolvedValueOnce({ paused: false })
    .mockResolvedValueOnce({ paused: true });
  render(<AdminPage api={fakeAdminApi({ paused: false })} getServerConfig={getServerConfig} />);
  await userEvent.click(screen.getByRole("button", { name: /pause deployment/i }));
  await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
  expect(await screen.findByText(/applying/i)).toBeInTheDocument();
  expect(await screen.findByText(/deployment is paused/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-frontend exec vitest run src/AdminPage.test.tsx`
Expected: FAIL — no such control.

- [ ] **Step 3: Implement**

In `AdminPage.tsx`, mirroring the `signupsEnabled` pattern exactly (`const [paused, setPaused] = useState(false)`, a `savingPaused` flag, and `applySettings` reading `view.paused`), add a control to the General tab. Requirements:

- Label the action by what it does next: **Pause deployment** / **Resume deployment**.
- Show the current state prominently when paused, so a forgotten pause is obvious.
- Say what pausing does, in one line: *"No agent turns run, for anyone. Only admins can sign in. Scheduled tasks are skipped, not lost."*
- Confirm before pausing — it locks out every other user.
- **After `setPaused()`, show "applying…" and poll `getServerConfig()` until its `paused` matches**, only then reporting the new state. `getSettings()` reads the `AdminSettings` DO's own copy, but every enforcement path reads the KV mirror, and `getServerConfig()` is built from that mirror. Claiming success off the DO would tell an admin that spend had stopped when it had not. Poll every 5s, give up after 90s with *"Still applying — enforcement reads a cached config and can lag up to a minute. Reload to check."* Never silently show the DO's value as if it were confirmed.

In `LoginPage.tsx`, when `serverConfig.paused`, render a notice above the sign-in controls: *"This deployment is paused. Only administrators can sign in right now."* Leave the sign-in controls enabled — admins must still be able to get in.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @gadgets/workshop-frontend exec vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-frontend/src
git commit -m "feat(frontend): add the pause control and paused notice"
```

---

### Task 11: Fork ledger, docs, and full verification

**Files:**
- Modify: `docs/fork-delta.md`
- Modify: `scripts/fork-intent.test.ts`
- Modify: `CLOUDFLARE_SETUP.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

This is fork behaviour upstream does not have, so the ratchet must defend it — that is the repo's rule, and `pnpm test` enforces the ledger/assertion pairing.

- [ ] **Step 1: Add the ledger rows**

Append to the Held table in `docs/fork-delta.md`:

```markdown
| **F8** | **An admin-controlled deployment pause switch** | |
| F8.1 | `paused` is part of AdminConfig and reaches the client | `workshop-backend/src/admin-config.ts`, `workshop-shared/src/api.ts` |
| F8.2 | A paused deployment admits only admins | `workshop-backend/src/server.ts`, `auth/login-flow.ts` |
| F8.3 | A paused deployment runs no agent turns and delivers no hooks | `workshop-backend/src/overseer.ts` |
| F8.4 | Paused schedules are released, not settled, so a one-time task survives | `gatekeeper-scheduler/src/driver-state.ts`, `schedule-driver.ts` |
| F8.5 | The pause state is confirmed from the mirror enforcement reads, never the DO's own copy | `workshop-frontend/src/AdminPage.tsx` |
```

- [ ] **Step 2: Add the matching assertions**

In `scripts/fork-intent.test.ts`, add F8.1–F8.5 with the same ids, following the existing `matches()`/`has()` style. F8.4 must assert `releaseRun` exists **and** that `schedule-driver.ts` references `isHookPausedError` — the two halves of the Finding-1 fix. F8.5 must assert `AdminPage.tsx` references `getServerConfig`, so a future refactor cannot quietly go back to trusting the DO's copy.

- [ ] **Step 3: Document it**

Add a "Pausing the deployment" section to `CLOUDFLARE_SETUP.md` §10 covering: where the control is; that it takes up to a minute and the UI confirms from the mirror; that schedules are skipped rather than lost and do not accumulate; that **no agent turns run for anyone, admins included**; that a non-admin already connected keeps non-agent access until their socket drops; that storage still bills; that `getBlueprint`/`downloadBlueprint` stay unauthenticated and open; that **inbound email would be bounced rather than queued if `gatekeeper-email` were ever installed** (Finding 5); and the lockout escape hatch —

```sh
source .envrc
pnpm exec wrangler kv key get --namespace-id=<BLUEPRINTS id> .adminConfig > cfg.json
# edit "paused": false
pnpm exec wrangler kv key put --namespace-id=<BLUEPRINTS id> .adminConfig --path cfg.json
```

noting this is a stopgap that the `AdminSettings` DO overwrites on its next write, so fix `ADMINS` and redeploy afterwards.

- [ ] **Step 4: Full verification**

Run: `pnpm lint`
Expected: exit 0

Run: `pnpm test`
Expected: PASS, including `fork-intent.test.ts`

Run: `pnpm deploy:check`
Expected: still valid — no deployment-config change was needed.

- [ ] **Step 5: Manual smoke test on the local stack**

Run: `pnpm run-local`, sign in as `admin`, pause from `/admin`, and confirm: a second non-admin account cannot sign in; the admin still can; a scheduled task due during the pause does not fire; after resuming, that task fires exactly once.

- [ ] **Step 6: Commit**

```bash
git add docs/fork-delta.md scripts/fork-intent.test.ts CLOUDFLARE_SETUP.md
git commit -m "docs: record the deployment pause switch as defended fork behaviour"
```

---

## Self-review notes

- **Spec coverage.** Four doors → Tasks 4, 7, 8 (turn), 7 (login). Finding 0 → Task 10. Finding 1 → Tasks 5, 6. Finding 2 → Task 6 Step 3b. Finding 3 → Task 2 plus the Task 4 Step 5 boundary check. Finding 4 → Tasks 3 and 7, escape hatch in Task 11. Finding 5 → documented in Tasks 4 and 11.
- **Ordering.** **Task 0 is a hard prerequisite — it must land before the first deploy, and Tasks 3, 7 and 8 depend on the module it creates.** Tasks 1 and 2 are independent of it. Task 4 needs 1 and 2; Task 6 needs 2 and 5; Tasks 7–8 need 1 and 3; Task 9 needs 1; Task 10 needs 9; Task 11 needs everything. Tasks 7 and 9 both edit `api.ts` — land 7 first, and rebase 9 on it rather than editing in parallel.

### Assumptions still unverified at plan time

Each is a stop-and-report point, not something to work around:

1. **The paused message survives Worker-to-Worker RPC** (Task 4 Step 5). Everything in Task 6 rests on it.
2. **`packages/integration-tests` can express a cross-Worker paused hook** (Task 4 Step 5). Fallback is a documented manual check, not a new harness.
3. **`#settle` is generic enough to reuse for release** (Task 6 Step 3a). If not, `#releasePending` gets its own transaction.
4. **`copyProgress` produces a value valid on an `active` schedule** (Task 5 Step 3). If not, mirror `rejectRun`'s active branch exactly.

### Deliberately not done

- Automatic tripping from a spend threshold, and draining in-flight turns — spec's out-of-scope section.
- **Kicking live non-admin sessions.** `abortSession` is a per-connection closure over one WebSocket ([`server.ts:923`](../../../packages/workshop-backend/src/server.ts#L923)); there is no session registry to enumerate. Building one is disproportionate. Non-admins already connected keep non-agent access until their socket drops; their agent turns are blocked, which is the spend.
- **Exempting admins from the turn gate.** Rejected in the spec — the Overseer DO cannot cheaply answer "is this turn's initiator an admin", and it would let the most expensive path keep running during a cost freeze.
- **Giving `gatekeeper-email` a retry queue** so mail is deferred rather than bounced. A real gap (Finding 5), but a separate feature and not installable on this deployment.
