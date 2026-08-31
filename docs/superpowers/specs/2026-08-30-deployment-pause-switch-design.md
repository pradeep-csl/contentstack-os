# Deployment pause switch — design

**Status:** proposed
**Date:** 2026-08-30
**Plan:** [`../plans/2026-08-30-deployment-pause-switch.md`](../plans/2026-08-30-deployment-pause-switch.md)

## Goal

A deployment admin can **pause** the instance from `/admin` and **resume** it later. While paused:

- **no agent turn runs, for anyone** — admins included — so no LLM spend is incurred;
- **no new sign-in succeeds for a non-admin**, by password, gatekeeper OAuth or Access;
- **a schedule that comes due while paused is not lost** — the run is released rather than settled, so
  `nextFire` stays exactly where it was; the occurrence that was due delivers as soon as the deployment
  resumes rather than being skipped to the schedule's next regular slot, and nothing accumulates beyond
  that one deferred delivery;
- **admins can still sign in and inspect** the instance — settings, workspaces, gadget contents —
  and are the only people who can resume it.

Two limits stated up front, because both were overclaimed in an earlier draft of this document:

- **Admins cannot run agent turns while paused either.** Verification while paused means signing in
  and looking around, not exercising the agent. Exempting admins would need the Overseer DO to
  resolve the *initiator's* admin status (a turn's initiator is not necessarily the workspace
  owner), and it would let the most expensive path keep spending during a cost freeze. Rejected.
- **Sessions already connected keep non-agent access until they reconnect.** `abortSession` is a
  per-connection closure over one WebSocket ([`server.ts:923`](../../../packages/workshop-backend/src/server.ts#L923));
  there is no registry of live sessions and no way to enumerate or close other users'. Kicking them
  would mean building a session registry in the kernel — out of proportion to a pause switch. So a
  non-admin already connected can still read and edit until their socket drops, but **cannot run an
  agent turn**, which is where the money is.

The motivating problem: Cloudflare has no hard spend cap, only notifications. This is a manual
circuit-breaker for cost containment. OpenRouter spend is capped separately by a per-key credit
limit set at OpenRouter, and is out of scope here.

## Cost model — what actually has to stop

Pausing has to close every door through which an agent turn can start. There are four, and they are
genuinely different code paths:

| Door | Entry point | Closed by |
| --- | --- | --- |
| New browser connections | `PublicApi.authenticate()` | admin check, reject non-admins |
| Gatekeeper sign-in | `LoginFlow` (`auth/login-flow.ts`) | admin check, reject non-admins |
| **Sessions already connected when pause is flipped** | live WebSocket holding an `AuthenticatedApi` | turn gate in `#runAgentTurnWithContext` |
| **Scheduled tasks** | `ScheduleDriver.alarm()` → `HookInitiator.startHook()` | `startHook()` refuses while paused |

The third and fourth are the ones a naive implementation misses. A live WebSocket stays
authenticated until it reconnects, so an auth-only gate leaks. And scheduled work runs from a
Durable Object alarm inside `gatekeeper-scheduler` with **no inbound HTTP request at all**, so
anything that only blocks the router or the front door leaks entirely.

## Where the flag lives

`AdminConfig.paused: boolean`, default `false`.

`AdminConfig` is owned by the `AdminSettings` durable object and mirrored to one reserved
`BLUEPRINTS` KV key, which hot paths already read with a single cheap `get`. Both chokepoints we
need — `startHook()` and the agent turn — **already call `readAdminConfig(env)`**, so the flag costs
nothing extra on either path.

**Consequence: pause is not instantaneous.** The KV mirror has a cache TTL (60s default), so a pause
can take up to ~60s to be seen everywhere. Acceptable for a budget control; it must be documented
rather than hidden, because an admin watching spend will expect an immediate stop.

### Finding 0 — the admin panel can lie about being paused

`getSettings()` returns `this.#config()` — the `AdminSettings` DO's **own** copy — while every
enforcement path reads the **KV mirror**. So the moment an admin flips the switch the panel says
"paused", and enforcement may keep serving for up to a minute, or indefinitely if the mirror write
failed. For a cost control, a dashboard reporting "stopped" while spend continues is the worst
available failure: it removes the operator's reason to look further.

**Decision:** the admin UI must confirm from the same source enforcement reads. After `setPaused()`
the panel shows an **"applying…"** state and polls the unauthenticated `getServerConfig()` — which
is built from `readAdminConfig(env)`, i.e. the mirror — until it agrees. Only then does the UI claim
the deployment is paused. This turns an invisible divergence into a visible, bounded wait.

`AdminConfig` is deliberately *not* where authentication config lives (that stays env-driven so a
compromised admin session cannot widen who gets in). Pause is the opposite kind of setting — it only
ever *narrows* access, and an admin needs to flip it from a phone during an incident. Putting it in
`AdminConfig` is consistent with that reasoning, not a violation of it.

## Finding 1 — the existing reject path expires one-time schedules

The driver already has a "hook refused" path, and at first glance it does exactly what we want
([`schedule-driver.ts:410-419`](../../../packages/gatekeeper-scheduler/src/schedule-driver.ts#L410-L419)):

```js
using hookCall = capabilities.initiator.startHook();
try { hookResult = await hookCall; }
catch { this.#rejectPending(prepared, Date.now()); return true; }
```

But `rejectRun` ([`driver-state.ts:149-163`](../../../packages/gatekeeper-scheduler/src/driver-state.ts#L149-L163)) is not a "skip":

```js
if (schedule.spec.kind === "once") {
  return { ...common, status: "expired", expiredAt: rejectedAt };   // permanently lost
}
const nextFire = recurringNextFire(schedule, rejectedAt);            // recurring: advances, fine
```

A **recurring** schedule advances to its next occurrence — the desired behaviour. A **one-time**
schedule is marked `expired` and **never fires**. Reusing this path would silently destroy every
one-time scheduled task that came due during a pause, which is precisely the regression this design
exists to avoid.

**Decision:** add a distinct *release* path that reverts the run without settling the schedule,
leaving `nextFire` untouched so the occurrence is still due and delivers after resume. Same
behaviour for `once` and recurring.

## Finding 2 — releasing without care creates an alarm hot-loop

`#runAlarm` sets a recovery alarm at `now + RECOVERY_DELAY_MS` (5 minutes) on entry, then calls
`#planAlarm()` at the end, which pulls the alarm forward to the earliest due schedule. If a released
schedule keeps `nextFire` in the past, `#planAlarm()` schedules the alarm for ~now, the alarm
re-fires immediately, releases again — a tight loop of Durable Object alarms and cross-worker RPCs
for the entire duration of the pause. That turns a cost-control feature into a cost.

**Decision:** when an alarm batch is abandoned because the deployment is paused, **return before
`#planAlarm()`**, leaving the 5-minute recovery alarm in place. While paused the driver polls every
5 minutes per account, which is negligible, and resumes promptly after the flag clears.

## Finding 3 — the pause signal crosses a Worker RPC boundary

`startHook()` runs in `workshop-backend`; the driver that must interpret its failure runs in
`gatekeeper-scheduler`. These are separate Workers. The driver has to distinguish
*"paused — release and retry later"* from *"hook deleted or gatekeeper disabled — settle it"*, and
getting that backwards is the Finding-1 regression again.

Custom error properties are not reliably preserved across a Worker-to-Worker RPC boundary
(`workshop-backend` sets `enhanced_error_serialization`; `gatekeeper-scheduler` does not). The
`message` is the dependable carrier — which is exactly why `AUTH_ERROR_MESSAGES` exists in
`workshop-shared` and is described there as a "classification fallback".

**Decision:** export a single constant `HOOK_PAUSED_MESSAGE` from
`@gadgets/workshop-shared/gatekeeper` — the contract package both Workers already depend on — throw
exactly that string from `startHook()`, and match it exactly in the driver. One source of truth, so
the two sides cannot drift.

**Risk accepted:** if the message stops propagating, the driver falls back to today's behaviour and
one-time schedules due during a pause expire. Task 4 pins this with a test at the RPC boundary
rather than only against a local mock, because a passing unit test against a mocked `HookInitiator`
would prove nothing about serialization.

**Fail-safe direction:** the driver treats *unrecognised* failures exactly as it does today
(settle/reject). Only the recognised paused message triggers release. So a broken signal degrades to
current behaviour, never to something worse.

## Finding 4 — the admin check must not become a lockout

`#isAdmin()` reads `env.ADMINS` and **throws `TypeError` if it is malformed**. If pause denied access
whenever the admin check throws, a paused deployment with a malformed `ADMINS` would lock out
everyone — including the admin who needs to un-pause.

**Decision:** the admin check is extracted to a shared helper and pause fails **closed** for
non-admins (deny on error). The escape hatch is documented rather than coded: an admin can clear the
flag by writing the reserved KV key (`.adminConfig`) directly with `wrangler`, which does not depend
on the app being reachable. This is a stopgap, not a verified-sound fix: the `AdminSettings` DO owns
the authoritative config and overwrites the KV mirror wholesale on its next write, silently undoing
the edit, so it buys enforcement-side relief only until the next write, never a substitute for fixing
the root cause. And when the root cause *is* a malformed `ADMINS`, the KV edit alone does not finish
the job — it gets the admin signed in, but `#isAdmin()` still throws inside `getAdminApi()`, so they
cannot press Resume from `/admin` either; they must still fix `ADMINS` and redeploy. That is still
strictly better than a code path that fails open under an error nobody noticed, but it is a bridge to
a redeploy, not a replacement for one.

### Finding 4b — case-sensitive identity is a latent lockout that pause arms

`#isAdmin()` compares the user key to `ADMINS` with an exact `admins.includes(name)`
([`server.ts:118`](../../../packages/workshop-backend/src/server.ts#L118)), and the verified email is
used **verbatim** as the user Durable Object name at all three entry points
([`login-flow.ts:121`](../../../packages/workshop-backend/src/auth/login-flow.ts#L121),
[`server.ts:745`](../../../packages/workshop-backend/src/server.ts#L745), `:765`).
`isEmailAllowed` lowercases only the domain, never the local part.

An identity provider returning `Pradeep.Mishra@contentstack.com` therefore passes the domain
allowlist but does **not** match `ADMINS: ["pradeep.mishra@contentstack.com"]`. Today that is
recoverable — you are signed in, `/admin` is simply missing. **Under pause it is a total lockout**:
not-an-admin plus paused means denied at `authenticate()` for everyone, recoverable only through the
`wrangler` escape hatch.

The same root cause already lets one person hold two accounts, since mixed-case addresses resolve to
different Durable Objects.

**Decision:** normalise the sign-in identity to lowercase at every entry point, and compare `ADMINS`
case-insensitively, as **Task 0 — a prerequisite that must land before the first deploy**. Durable
Object names cannot be renamed, so doing this once accounts exist orphans them. The deployment has
zero accounts today; this is the only moment it is free.

## Finding 5 — the scheduler is not the only hook consumer

The `startHook()` gate is not scheduler-specific. It refuses **every** hook in the deployment, and
there is a second consumer: `gatekeeper-email`. Unlike the scheduler it has no failure handling at
all ([`email.ts:672`](../../../packages/gatekeeper-email/src/email.ts#L672)):

```js
using startHookResult = hookInitiator.startHook();
await startHookResult.approvalQueue.authorizeObservation({ ... });
await startHookResult.callback.receiveEmail(email);
```

A throw propagates out of `receiveEmail()` and fails the Email Worker handler, so **an inbound
message received while paused is rejected or bounced, not queued**. Schedules survive a pause;
email does not.

**Decision:** accept and document, do not special-case. Email Routing needs a zone, so
`gatekeeper-email` is `NOT_INSTALLABLE` on a workers.dev deployment and is not installed here. But
this design changes shared kernel behaviour, so the asymmetry is recorded in `CLOUDFLARE_SETUP.md`
and in the fork ledger: anyone who later installs email must know that pausing drops mail rather
than deferring it. Giving email a retry queue is a separate feature, not a rider on this one.

## Behaviour decisions

| Question | Decision | Why |
| --- | --- | --- |
| Do missed occurrences accumulate? | **No.** One occurrence fires after resume, not one per missed slot. | A backlog of agent turns firing at once on resume is an expensive surprise — the opposite of the feature's purpose. Explicitly requested. |
| Are admins' scheduled tasks exempt? | **No.** All schedules pause. | Schedules are not attributable to a live admin session, and "stop everything" was the requirement. Admins verify by using the app directly. |
| Are callback-initiated agent turns exempt? | **No.** | The free-tier usage limit exempts them to avoid stranding flows, but pause exists to stop spend. The existing `finally` clears active-agent state and emits a stream `clear`, so the UI does not hang. |
| Does the router block traffic? | **No.** | The router serves the frontend and has no session context. Blocking there would lock admins out too. `getServerConfig()` carries `paused` so the UI can explain itself while admins sign in normally. |
| Is signup blocked? | Yes, via the same non-admin gate. | Password signup is already off in this deployment; the gate covers the gatekeeper path. |
| What about a run already past admission when pause lands? | It delivers. | `releaseRun` is guarded to the admission stage, so a run that reached delivery completes. Consistent with "in-flight turns finish", and reverting a half-delivered run is worse than letting one finish. |

## Rejected alternative — gate only the agent turn

Worth recording because it is half the kernel diff and none of the risk: **do not gate
`startHook()` at all**, and rely solely on the agent-turn gate. No `releaseRun`, no shared error
constant, no cross-Worker signal to verify, no email regression.

Rejected because of what it does to schedules. The hook would be delivered, the schedule would
**advance normally as if the work had happened**, the gadget callback would run (costing Workers
compute), and only the agent turn inside it would be refused. A schedule due during the pause is
then silently consumed rather than deferred — the opposite of the stated requirement that a
schedule be untouched and fire as expected after resume.

## Explicitly out of scope

- **Automatic tripping from a spend threshold.** This is a manual switch. Wiring a Cloudflare
  billing notification to a webhook that flips it is a sensible follow-up, and this design leaves
  room for it (the flag is a normal `AdminConfig` field), but auto-trip needs a spend signal the
  instance does not currently accumulate.
- **OpenRouter budget enforcement.** Capped at OpenRouter with a per-key credit limit.
- **Stopping storage costs.** R2 objects, KV entries and Durable Object storage-at-rest keep
  billing while paused. They are flat and small; compute and inference are what spike.
- **Draining in-flight turns.** A turn already running when pause is flipped finishes.

## Regression surface

| Risk | Mitigation |
| --- | --- |
| One-time schedules expire during a pause | Finding 1 — release rather than reject; Task 5 tests `once` explicitly |
| Alarm hot-loop while paused | Finding 2 — skip `#planAlarm()`; Task 6 tests alarm scheduling |
| Paused signal lost across RPC → schedules expire | Finding 3 — shared constant, boundary test, degrade to current behaviour |
| Stored `AdminConfig` predates the field | `parseAdminConfig` defaults `paused` to `false`; Task 1 tests an object with the key absent |
| `ServerConfig` gains a required field | Single construction site (`deployment-config.ts`); `tsc` catches any other |
| Admin locked out by malformed `ADMINS` | Finding 4 — documented `wrangler` escape hatch |
| Admin locked out by a mixed-case verified email | Finding 4b — Task 0 normalises the identity before pause exists |
| One person ends up with two accounts | Finding 4b — same normalisation; must land before any account is created |
| Paused deployment silently stays paused | `/admin` shows state prominently, and any turn attempt posts a paused chat message explaining why; `getServerConfig().paused` is what the admin panel itself confirms against (Finding 0) — a signed-in admin sees no banner elsewhere in the app |
| Existing hook rejections change behaviour | Only the exact paused message takes the new path; everything else is untouched |
| Admin panel claims paused while enforcement still serves | Finding 0 — the UI polls `getServerConfig()` (the mirror) before claiming success |
| Inbound email dropped rather than deferred while paused | Finding 5 — documented, not installed here; ledger row F8.5 |
| Paused signal swallowed by an intermediate `catch` | Signalled as a returned discriminated result, not a thrown sentinel — `#deliver` already catches everything `#deliverPrepared` throws |

## Surfaces that remain open while paused

Stated so "everything stops" is not read as literal:

- `getBlueprint(id)` and `downloadBlueprint(id)` are unauthenticated, so no admin exemption is
  possible and they keep serving. Cheap, and unchanged from today's exposure.
- `/blueprint-screenshot/*`, the site logo and `getServerConfig()` keep serving — the last is
  required, since the login page needs to know it is paused.
- Storage keeps billing: R2 objects, KV entries, Durable Object storage-at-rest.
