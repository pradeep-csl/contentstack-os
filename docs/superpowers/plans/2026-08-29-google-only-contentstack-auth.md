# Google-Only Sign-In With a Contentstack Domain Allowlist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Google the only way into this deployment, restricted to `@contentstack.com` addresses, with sessions that expire so Google's answer keeps counting.

**Architecture:** Three env-driven switches read in `workshop-backend/src/auth/config.ts` — an existing gatekeeper allowlist, a new email-domain allowlist, and a new session max age. The domain check runs at the one chokepoint every gatekeeper login passes through (`LoginConnectCallbackImpl.complete()`), before any user Durable Object is created. Session expiry runs in `UserDurableObject.authenticate()`, the one place every session validation passes through. The deploy harness grows two config fields and four validation rules so a config that would silently void the restriction cannot be generated.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, vitest with `@cloudflare/vitest-pool-workers` (backend tests run inside workerd), `node --test` (scripts tests), pnpm.

**Spec:** [`docs/superpowers/specs/2026-08-29-google-only-contentstack-auth-design.md`](../specs/2026-08-29-google-only-contentstack-auth-design.md)

## Global Constraints

- **pnpm, never npm.** Commands run from the repo root unless a step says otherwise.
- **Never add AI/LLM attribution or `Co-Authored-By` metadata to commit messages.**
- **`workshop-backend` is the kernel.** Reviewers read every line. Keep diffs small; doc-comment every exported member.
- **Authentication config stays env-driven**, never in `AdminConfig` — a compromised admin session must not be able to widen who may sign in.
- **New behaviour is off by default.** With `ALLOWED_EMAIL_DOMAINS` and `SESSION_MAX_AGE_HOURS` unset, the deployment behaves exactly as upstream does today. Every test must include a case proving that.
- **Exact var names:** `ALLOWED_EMAIL_DOMAINS` (comma-separated bare domains), `SESSION_MAX_AGE_HOURS` (a positive number of hours).
- **Exact config field names:** `auth.allowedEmailDomains` (`string[]`), `auth.sessionMaxAgeHours` (`number`).
- **Domain matching is exact**, case-insensitive, on the substring after the *last* `@`. No wildcards, no subdomain matching.
- **Rejection message (verbatim), built from the configured domains:**
  `Only @contentstack.com accounts can sign in to this deployment.`
  Built as `` `Only ${domains.map(d => "@" + d).join(" or ")} accounts can sign in to this deployment.` ``
- **Running backend tests:** `cd packages/workshop-backend && pnpm exec vitest run __tests__/<file>.test.ts`. If this is a fresh checkout where generated sources are missing, run `pnpm --filter @gadgets/workshop-backend run test:run` once first — it generates the browser runtime and format blueprints that the suite imports.
- **Running scripts tests:** `node --test scripts/deploy/deployment-config.test.ts` (and similar) from the repo root.
- **Full gate before the final commit:** `pnpm lint` (oxlint + `tsc --noEmit`) and `pnpm test`.

---

### Task 1: Auth config primitives and the fail-closed password rule

Adds the two new settings to the file that already owns the deployment's authentication switches, and makes a configured domain allowlist disable password auth outright. Upstream fails *open* there (password auth stays on when no gatekeeper is configured, so a misconfiguration cannot lock everyone out); that default is wrong once a domain restriction exists, because password accounts are keyed by username and therefore cannot be gated by any email check.

**Files:**
- Modify: `packages/workshop-backend/src/auth/config.ts` (whole file — 33 lines today)
- Modify: `packages/workshop-backend/src/env.d.ts:75-81` (the optional-features block)
- Test: `packages/workshop-backend/__tests__/auth-config.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type AuthEnv = Readonly<{ AUTH_GATEKEEPERS?: string; DISABLE_PASSWORD_AUTH?: string; ALLOWED_EMAIL_DOMAINS?: string; SESSION_MAX_AGE_HOURS?: string }>`
  - `export function getAuthGatekeeperAllowlist(env: AuthEnv): string[]` (existing, widened from `Cloudflare.Env`)
  - `export function hasAuthGatekeepers(env: AuthEnv): boolean` (existing, widened)
  - `export function isPasswordAuthEnabled(env: AuthEnv): boolean` (existing, widened + new first clause)
  - `export function getAllowedEmailDomains(env: AuthEnv): string[]`
  - `export function isEmailAllowed(email: string, env: AuthEnv): boolean`
  - `export function emailDomainRejectionMessage(env: AuthEnv): string`
  - `export function getSessionMaxAgeMs(env: AuthEnv): number | null`

Widening the parameter type from `Cloudflare.Env` to `AuthEnv` is safe — `Cloudflare.Env` declares all four as optional strings, so every existing call site still type-checks — and it follows the existing `CfAccessEnv` precedent in `src/access.ts`, lets the tests pass plain object literals with no casts, and removes the `(env as { AUTH_GATEKEEPERS?: string })` cast the file has today.

- [ ] **Step 1: Write the failing tests**

Create `packages/workshop-backend/__tests__/auth-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  emailDomainRejectionMessage,
  getAllowedEmailDomains,
  getSessionMaxAgeMs,
  isEmailAllowed,
  isPasswordAuthEnabled,
} from "../src/auth/config.js";

describe("getAllowedEmailDomains", () => {
  it("is empty when unset", () => {
    expect(getAllowedEmailDomains({})).toEqual([]);
  });

  it("normalizes case, whitespace and empty entries", () => {
    expect(getAllowedEmailDomains({ ALLOWED_EMAIL_DOMAINS: " Contentstack.com , ,example.COM " }))
      .toEqual(["contentstack.com", "example.com"]);
  });
});

describe("isEmailAllowed", () => {
  const restricted = { ALLOWED_EMAIL_DOMAINS: "contentstack.com" };

  it("allows anything when no allowlist is configured", () => {
    expect(isEmailAllowed("anyone@example.com", {})).toBe(true);
  });

  it("allows an exact domain match regardless of case", () => {
    expect(isEmailAllowed("person@contentstack.com", restricted)).toBe(true);
    expect(isEmailAllowed("Person@Contentstack.COM", restricted)).toBe(true);
  });

  // Suffix matching would accept every one of these, which is the whole point of matching exactly.
  it("rejects lookalike and subdomain addresses", () => {
    expect(isEmailAllowed("person@evilcontentstack.com", restricted)).toBe(false);
    expect(isEmailAllowed("person@sub.contentstack.com", restricted)).toBe(false);
    expect(isEmailAllowed("person@contentstack.com.evil.example", restricted)).toBe(false);
  });

  // Google quotes the address verbatim; an address containing "@" must not let the local part
  // dictate the domain.
  it("matches on the domain after the last @", () => {
    expect(isEmailAllowed("weird@contentstack.com@evil.example", restricted)).toBe(false);
    expect(isEmailAllowed("\"a@b\"@contentstack.com", restricted)).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isEmailAllowed("no-at-sign", restricted)).toBe(false);
    expect(isEmailAllowed("trailing@", restricted)).toBe(false);
    expect(isEmailAllowed("", restricted)).toBe(false);
  });

  it("honours every configured domain", () => {
    const multi = { ALLOWED_EMAIL_DOMAINS: "contentstack.com,example.com" };
    expect(isEmailAllowed("person@example.com", multi)).toBe(true);
  });
});

describe("emailDomainRejectionMessage", () => {
  it("names the configured domains", () => {
    expect(emailDomainRejectionMessage({ ALLOWED_EMAIL_DOMAINS: "contentstack.com" }))
      .toBe("Only @contentstack.com accounts can sign in to this deployment.");
    expect(emailDomainRejectionMessage({ ALLOWED_EMAIL_DOMAINS: "contentstack.com,example.com" }))
      .toBe("Only @contentstack.com or @example.com accounts can sign in to this deployment.");
  });
});

describe("isPasswordAuthEnabled", () => {
  it("is on by default", () => {
    expect(isPasswordAuthEnabled({})).toBe(true);
  });

  it("honours the flag once a sign-in gatekeeper exists", () => {
    expect(isPasswordAuthEnabled({ DISABLE_PASSWORD_AUTH: "true", AUTH_GATEKEEPERS: "google" }))
      .toBe(false);
  });

  // Upstream's anti-lockout escape hatch: without gatekeepers the flag is ignored.
  it("ignores the flag when no gatekeeper can sign anyone in", () => {
    expect(isPasswordAuthEnabled({ DISABLE_PASSWORD_AUTH: "true" })).toBe(true);
  });

  // ...but a domain allowlist overrides that escape hatch. Password accounts are keyed by username,
  // so leaving password auth on would reopen unrestricted signup and void the allowlist entirely.
  it("is off whenever a domain allowlist is configured, even with no gatekeepers", () => {
    expect(isPasswordAuthEnabled({ ALLOWED_EMAIL_DOMAINS: "contentstack.com" })).toBe(false);
  });
});

describe("getSessionMaxAgeMs", () => {
  it("is null when unset, so sessions never expire", () => {
    expect(getSessionMaxAgeMs({})).toBeNull();
  });

  it("converts hours to milliseconds", () => {
    expect(getSessionMaxAgeMs({ SESSION_MAX_AGE_HOURS: "24" })).toBe(86_400_000);
    expect(getSessionMaxAgeMs({ SESSION_MAX_AGE_HOURS: "0.5" })).toBe(1_800_000);
  });

  // Treating garbage as 0 would expire every session the instant it was issued.
  it("treats a non-positive or unparseable value as unset", () => {
    expect(getSessionMaxAgeMs({ SESSION_MAX_AGE_HOURS: "0" })).toBeNull();
    expect(getSessionMaxAgeMs({ SESSION_MAX_AGE_HOURS: "-1" })).toBeNull();
    expect(getSessionMaxAgeMs({ SESSION_MAX_AGE_HOURS: "soon" })).toBeNull();
    expect(getSessionMaxAgeMs({ SESSION_MAX_AGE_HOURS: "" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/workshop-backend && pnpm exec vitest run __tests__/auth-config.test.ts`
Expected: FAIL — `getAllowedEmailDomains`, `isEmailAllowed`, `emailDomainRejectionMessage` and `getSessionMaxAgeMs` are not exported by `../src/auth/config.js`.

- [ ] **Step 3: Rewrite `packages/workshop-backend/src/auth/config.ts`**

Replace the whole file with:

```ts
// Configuration for sign-in via authentication gatekeepers (an optional, additive login feature).
//
// Authentication is provided by gatekeepers (e.g. "google", "github", "cloudflare") that advertise
// `providesAuth`. A deployment opts specific gatekeepers into the login UI via the AUTH_GATEKEEPERS
// allowlist (comma-separated vendor ids). When set, each listed, auth-capable gatekeeper gets a
// "Continue with ..." button alongside the normal username/password form (unless password auth is
// disabled). All OFF by default.
//
// A deployment may additionally restrict *who* may sign in (ALLOWED_EMAIL_DOMAINS) and how long a
// session lasts before the provider must be consulted again (SESSION_MAX_AGE_HOURS). All of this is
// env-driven rather than part of AdminConfig, deliberately: a compromised admin session must not be
// able to widen who can get in.

/** The deployment's authentication settings, as read from the environment. */
export type AuthEnv = Readonly<{
  AUTH_GATEKEEPERS?: string;
  DISABLE_PASSWORD_AUTH?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  SESSION_MAX_AGE_HOURS?: string;
}>;

/** Split a comma-separated env var into trimmed, lowercased, non-empty entries. */
function commaList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Parse the AUTH_GATEKEEPERS allowlist into a list of gatekeeper vendor ids (lowercased). These are
 * the gatekeepers permitted to drive sign-in; a vendor must also actually advertise `providesAuth`
 * to be offered. Empty when unset.
 */
export function getAuthGatekeeperAllowlist(env: AuthEnv): string[] {
  return commaList(env.AUTH_GATEKEEPERS);
}

/** Whether the deployment has opted any gatekeeper into sign-in. */
export function hasAuthGatekeepers(env: AuthEnv): boolean {
  return getAuthGatekeeperAllowlist(env).length > 0;
}

/**
 * The email domains permitted to sign in, lowercased. Empty means unrestricted, which is the
 * default and matches upstream behaviour.
 */
export function getAllowedEmailDomains(env: AuthEnv): string[] {
  return commaList(env.ALLOWED_EMAIL_DOMAINS);
}

/**
 * Whether `email` may sign in to this deployment. True for every address when no allowlist is
 * configured. Matching is an exact, case-insensitive comparison of the domain after the last `@`:
 * no wildcards and no subdomains, so `sub.example.com` and `evilexample.com` are both refused when
 * `example.com` is allowed.
 */
export function isEmailAllowed(email: string, env: AuthEnv): boolean {
  const allowed = getAllowedEmailDomains(env);
  if (allowed.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 && allowed.includes(domain);
}

/**
 * The message shown to someone whose address is outside the allowlist. It names the permitted
 * domains: a user who picked the wrong profile needs to know which one to pick, and the domain is
 * not a secret.
 */
export function emailDomainRejectionMessage(env: AuthEnv): string {
  const allowed = getAllowedEmailDomains(env);
  const domains = allowed.map(domain => `@${domain}`).join(" or ");
  return `Only ${domains} accounts can sign in to this deployment.`;
}

/**
 * How long a session token stays valid, in milliseconds, or null when sessions never expire (the
 * default, and upstream's behaviour). Values that are not a positive number are treated as unset:
 * reading garbage as 0 would expire every session the instant it was issued.
 */
export function getSessionMaxAgeMs(env: AuthEnv): number | null {
  const hours = Number(env.SESSION_MAX_AGE_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return hours * 60 * 60 * 1000;
}

/**
 * Whether username/password login + signup is available. Enabled by default, with two ways off.
 *
 * A configured email-domain allowlist disables it unconditionally: password accounts are keyed by
 * username rather than by email, so no domain check can gate them, and leaving password signup open
 * would silently void the allowlist. That deliberately overrides the anti-lockout rule below —
 * a misconfigured deployment should refuse everyone and be fixed, not quietly admit strangers.
 *
 * Otherwise DISABLE_PASSWORD_AUTH=true makes the deployment OAuth-only, but only takes effect when
 * at least one auth gatekeeper is allowlisted, since otherwise we'd lock everyone out.
 */
export function isPasswordAuthEnabled(env: AuthEnv): boolean {
  if (getAllowedEmailDomains(env).length > 0) return false;
  if (env.DISABLE_PASSWORD_AUTH !== "true") return true;
  return !hasAuthGatekeepers(env);
}
```

- [ ] **Step 4: Declare the new vars in `packages/workshop-backend/src/env.d.ts`**

Immediately after the `DISABLE_PASSWORD_AUTH?: string;` declaration (currently line 80), add:

```ts
      // Comma-separated allowlist of email domains permitted to sign in, e.g. "contentstack.com".
      // Matched exactly (no subdomains) against the verified email's domain, at every point that
      // resolves an email to a user. Empty = unrestricted. Setting this also disables password auth
      // outright, since password accounts are keyed by username and cannot be domain-checked.
      ALLOWED_EMAIL_DOMAINS?: string;

      // How long a session token stays valid, in hours. Unset = sessions never expire. Bounded
      // sessions are what make ALLOWED_EMAIL_DOMAINS (and the identity provider's own offboarding)
      // keep counting after the first sign-in.
      SESSION_MAX_AGE_HOURS?: string;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/workshop-backend && pnpm exec vitest run __tests__/auth-config.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 6: Verify nothing else broke**

Run: `pnpm lint`
Expected: clean. `getAuthGatekeeperAllowlist`, `hasAuthGatekeepers` and `isPasswordAuthEnabled` now take `AuthEnv`; every existing call site passes `Cloudflare.Env`, which is assignable. If `tsc` complains at a call site, that call site is passing something narrower than the four declared vars — fix the call site, do not widen `AuthEnv` back to `Cloudflare.Env`.

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-backend/src/auth/config.ts \
        packages/workshop-backend/src/env.d.ts \
        packages/workshop-backend/__tests__/auth-config.test.ts
git commit -m "feat(auth): add an email-domain allowlist and session max age to auth config"
```

---

### Task 2: Enforce the domain allowlist at every email-keyed entry point

Wires the check into the two places that turn a verified email into a user Durable Object. The check must run **before** the account is resolved or created, so a rejected address leaves nothing behind.

**Files:**
- Modify: `packages/workshop-backend/src/auth/login-flow.ts:92-122` (inside `LoginConnectCallbackImpl.complete()`)
- Modify: `packages/workshop-backend/src/server.ts:753-776` (`PublicApiImpl.authenticateFromCfAccess()`)
- Test: `packages/workshop-backend/__tests__/login-domain-allowlist.test.ts` (create)

**Interfaces:**
- Consumes: `isEmailAllowed(email, env)` and `emailDomainRejectionMessage(env)` from Task 1.
- Produces: no new exports. The `gatekeeper.login.finished` log event gains a new `outcome` value, `"domain_not_allowed"`, alongside the existing `no_email`, `signups_disabled`, `ok` and `error`.

The test constructs `LoginConnectCallbackImpl` directly with a fake `ctx` (its `props` and `exports`) and a fake `account`, and mocks `readAdminConfig` so no KV binding is needed. **This harness is verified to work in this repo's workerd test pool** — the class is a plain `WorkerEntrypoint` subclass and constructs fine.

The Cloudflare Access path (`authenticateFromCfAccess`) has no automated test: `PublicApiImpl` is not exported, and standing up an Access-authenticated RPC session would cost far more than the three-line change is worth. It is covered by the Task 5 fork-intent assertion, which fails if either call site stops referencing `isEmailAllowed`.

- [ ] **Step 1: Write the failing test**

Create `packages/workshop-backend/__tests__/login-domain-allowlist.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";

// complete() reads the deployment's signup switch from KV. Stubbing it keeps this test to the
// question it is asking -- who may sign in -- and needs no KV binding.
vi.mock("../src/admin-config.js", () => ({
  readAdminConfig: async () => ({ signupsEnabled: true }),
}));

/** The calls complete() makes, recorded by the fakes below. */
type Recorder = {
  failures: string[];
  delivered: string[];
  logins: string[];
};

/**
 * Build a callback wired to fakes for the two Durable Objects it reaches through `ctx.exports`.
 * `LoginConnectCallbackImpl` is a plain WorkerEntrypoint subclass, so constructing it directly with
 * a hand-built ctx is the cheapest way to exercise complete() without an OAuth round trip.
 */
function makeCallback(env: Record<string, string>): {
  complete: (email: string | null) => Promise<void>;
  recorder: Recorder;
} {
  const recorder: Recorder = { failures: [], delivered: [], logins: [] };
  const pending = {
    fail: async (reason: string) => { recorder.failures.push(reason); },
    deliver: async (token: string) => { recorder.delivered.push(token); },
  };
  const userStub = {
    loginOrCreateViaGatekeeper: async (email: string, _allowCreate: boolean) => {
      recorder.logins.push(email);
      return "session-secret";
    },
  };
  const ctx = {
    props: { pendingId: "pending-1", vendorId: "google" },
    exports: {
      PendingLogin: { idFromString: (id: string) => id, get: () => pending },
      UserDurableObject: { idFromName: (name: string) => name, get: () => userStub },
    },
  };
  const callback = new (LoginConnectCallbackImpl as unknown as new (
    ctx: unknown, env: unknown) => { complete(account: unknown): Promise<void> })(ctx, env);

  return {
    recorder,
    complete: (email) => callback.complete({ getAuthenticatedEmail: async () => email }),
  };
}

describe("gatekeeper login with a domain allowlist", () => {
  const restricted = { ALLOWED_EMAIL_DOMAINS: "contentstack.com" };

  it("signs in an address inside the allowlist", async () => {
    const { complete, recorder } = makeCallback(restricted);
    await complete("person@contentstack.com");

    expect(recorder.delivered).toEqual(["person@contentstack.com:session-secret"]);
    expect(recorder.failures).toEqual([]);
  });

  // The rejection must happen before the account is resolved: a refused address must not leave a
  // user Durable Object behind.
  it("refuses an address outside the allowlist without creating an account", async () => {
    const { complete, recorder } = makeCallback(restricted);
    await complete("person@example.com");

    expect(recorder.failures)
      .toEqual(["Only @contentstack.com accounts can sign in to this deployment."]);
    expect(recorder.delivered).toEqual([]);
    expect(recorder.logins).toEqual([]);
  });

  it("refuses a lookalike domain", async () => {
    const { complete, recorder } = makeCallback(restricted);
    await complete("person@evilcontentstack.com");

    expect(recorder.logins).toEqual([]);
    expect(recorder.delivered).toEqual([]);
  });

  it("signs in any address when no allowlist is configured", async () => {
    const { complete, recorder } = makeCallback({});
    await complete("anyone@example.com");

    expect(recorder.delivered).toEqual(["anyone@example.com:session-secret"]);
  });

  it("still refuses an account with no verified email", async () => {
    const { complete, recorder } = makeCallback(restricted);
    await complete(null);

    expect(recorder.failures).toEqual([
      "This account has no verified email, so it can't be used to sign in.",
    ]);
    expect(recorder.logins).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/workshop-backend && pnpm exec vitest run __tests__/login-domain-allowlist.test.ts`
Expected: FAIL — "refuses an address outside the allowlist" fails because `recorder.delivered` contains `person@example.com:session-secret`; nothing checks the domain yet.

- [ ] **Step 3: Add the check to `login-flow.ts`**

Extend the import at the top of the file:

```ts
import { emailDomainRejectionMessage, isEmailAllowed } from "./config.js";
```

Then, inside `complete()`, insert the guard immediately after the `if (!email) { ... }` block and **before** `const userStub = ...`:

```ts
      // Refuse an address outside the deployment's allowlist here, ahead of resolving the user DO,
      // so a rejected sign-in leaves no account behind. The message names the permitted domains.
      if (!isEmailAllowed(email, this.env)) {
        loginLogger.info("gatekeeper login finished", {
          event: "gatekeeper.login.finished", outcome: "domain_not_allowed",
        });
        await pending.fail(emailDomainRejectionMessage(this.env));
        return;
      }
```

The rejected address is deliberately not logged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/workshop-backend && pnpm exec vitest run __tests__/login-domain-allowlist.test.ts`
Expected: PASS — all five cases green.

- [ ] **Step 5: Add the same check to the Cloudflare Access path**

In `packages/workshop-backend/src/server.ts`, extend the existing auth-config import (currently `import { isPasswordAuthEnabled, getAuthGatekeeperAllowlist } from "./auth/config.js";`) to also bring in `isEmailAllowed` and `emailDomainRejectionMessage`.

Then in `authenticateFromCfAccess()`, immediately after `let email = this.accessPayload.email as string;` and before `let userId = ...`:

```ts
    // The other place an email becomes an account. Gate it too, so the allowlist has no second door.
    if (!isEmailAllowed(email, this.env)) {
      throw new Error(emailDomainRejectionMessage(this.env));
    }
```

- [ ] **Step 6: Verify the whole backend suite still passes**

Run: `cd packages/workshop-backend && pnpm exec vitest run`
Expected: PASS — no existing test configures `ALLOWED_EMAIL_DOMAINS`, so every one of them takes the unrestricted path.

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-backend/src/auth/login-flow.ts \
        packages/workshop-backend/src/server.ts \
        packages/workshop-backend/__tests__/login-domain-allowlist.test.ts
git commit -m "feat(auth): refuse sign-in from email domains outside the allowlist"
```

---

### Task 3: Expire session tokens

Without this, the allowlist gates login only: a token, once issued, works forever, because `authenticate()` checks that a session record exists and never looks at its age. Offboarding someone at the identity provider would not end their access. An **absolute** lifetime from issue time is what forces a fresh provider check; an idle timeout would not, since an active user would never re-verify.

**Files:**
- Modify: `packages/workshop-backend/src/user.ts:305-320` (`UserDurableObject.authenticate()`) and its import block
- Modify: `packages/workshop-backend/vitest.config.ts:18` (add a test binding)
- Test: `packages/workshop-backend/__tests__/session-expiry.test.ts` (create)

**Interfaces:**
- Consumes: `getSessionMaxAgeMs(env)` from Task 1.
- Produces: no new exports. `UserDurableObject.authenticate(token)` now throws `createAuthError(AUTH_ERROR_CODES.invalidSessionToken)` for an expired session and deletes the record.

Reusing `invalidSessionToken` rather than adding an expiry-specific code is deliberate: the client behaviour is identical (the frontend already treats `auth` errors as terminal and routes to a fresh login), and a distinct code would tell an unauthenticated caller *why* their token failed.

- [ ] **Step 1: Give the test pool a session max age**

In `packages/workshop-backend/vitest.config.ts`, inside the `miniflare` block, immediately after the `compatibilityFlags` line:

```ts
        // Session expiry is env-driven and off by default; the suite sets it so the expiry path is
        // exercised. Tests that create a session and use it immediately are unaffected.
        bindings: { SESSION_MAX_AGE_HOURS: '24' },
```

- [ ] **Step 2: Write the failing test**

Create `packages/workshop-backend/__tests__/session-expiry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type SessionRecord = { tokenId: string; created: Date };
type SessionStore = { list(): Iterable<SessionRecord>; put(record: SessionRecord): void };

/**
 * Reach the DO's own session records so a test can age one. The alternative -- recomputing the
 * token's SHA-256 id here -- would duplicate the DO's hashing scheme in the test.
 */
function sessionsOf(user: UserDurableObject): SessionStore {
  return (user as unknown as { storage: { sessions: SessionStore } }).storage.sessions;
}

/** Backdate every session record this user holds by `hours`. */
function ageSessions(user: UserDurableObject, hours: number): void {
  const sessions = sessionsOf(user);
  for (const record of Array.from(sessions.list())) {
    sessions.put({ ...record, created: new Date(Date.now() - hours * 60 * 60 * 1000) });
  }
}

describe("session expiry", () => {
  it("accepts a session inside the configured max age", async () => {
    await runInDurableObject(env.TEST_USER.getByName("fresh@example.com"), async (user) => {
      const token = await user.loginOrCreateViaGatekeeper("fresh@example.com", true);
      ageSessions(user, 23);

      await expect(user.authenticate(token!)).resolves.toBeUndefined();
    });
  });

  it("rejects a session older than the configured max age", async () => {
    await runInDurableObject(env.TEST_USER.getByName("stale@example.com"), async (user) => {
      const token = await user.loginOrCreateViaGatekeeper("stale@example.com", true);
      ageSessions(user, 25);

      await expect(user.authenticate(token!)).rejects.toThrow(/invalid session token/i);
    });
  });

  // Nothing else prunes this collection, so an expiring session must remove its own record.
  it("deletes the expired record rather than leaving it to accumulate", async () => {
    await runInDurableObject(env.TEST_USER.getByName("pruned@example.com"), async (user) => {
      const token = await user.loginOrCreateViaGatekeeper("pruned@example.com", true);
      ageSessions(user, 25);

      await expect(user.authenticate(token!)).rejects.toThrow();
      expect(Array.from(sessionsOf(user).list())).toEqual([]);
    });
  });

  it("still rejects a token that was never issued", async () => {
    await runInDurableObject(env.TEST_USER.getByName("bogus@example.com"), async (user) => {
      await user.loginOrCreateViaGatekeeper("bogus@example.com", true);

      await expect(user.authenticate("bm90LWEtcmVhbC10b2tlbg==")).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/workshop-backend && pnpm exec vitest run __tests__/session-expiry.test.ts`
Expected: FAIL — "rejects a session older than the configured max age" resolves instead of rejecting, because the record's age is never consulted.

- [ ] **Step 4: Enforce the max age in `authenticate()`**

In `packages/workshop-backend/src/user.ts`, add to the imports:

```ts
import { getSessionMaxAgeMs } from "./auth/config.js";
```

Then replace the tail of `authenticate()` — the current `let session = ...; if (!session) { throw ... }` — with:

```ts
    let session = this.storage.sessions.get(tokenId);
    if (!session) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    // A session that outlives its max age must be re-established through the sign-in provider, which
    // is what keeps the provider's answer about who may sign in true after the first login. Deleting
    // the record on the way out is also the only thing that prunes this collection.
    let maxAgeMs = getSessionMaxAgeMs(this.env);
    if (maxAgeMs !== null && Date.now() - session.created.getTime() > maxAgeMs) {
      this.storage.sessions.delete(tokenId);
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/workshop-backend && pnpm exec vitest run __tests__/session-expiry.test.ts`
Expected: PASS — all four cases green.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd packages/workshop-backend && pnpm exec vitest run`
Expected: PASS. Every other test creates and uses a session within the same run, far inside 24 hours.

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-backend/src/user.ts \
        packages/workshop-backend/vitest.config.ts \
        packages/workshop-backend/__tests__/session-expiry.test.ts
git commit -m "feat(auth): expire session tokens against a configurable maximum age"
```

---

### Task 4: Carry both settings through the deploy harness and local dev

Adds the two fields to the deployment config and makes `pnpm deploy:check` reject a configuration that would silently void the restriction.

**Files:**
- Modify: `scripts/deploy/deployment-config.ts` — `AuthConfig` (~line 30), `applyBackendConfig` (~line 396), `validateAuth` (~line 581)
- Modify: `deployment.example.jsonc` (the `auth` block — fields documented as comments; see Step 7)
- Modify: `scripts/run-dev-server.ts:508-510` (`OPTIONAL_FEATURE_VARS`)
- Modify: `.env.example:35-44` (the sign-in block)
- Test: `scripts/deploy/deployment-config.test.ts` (extend)

**Interfaces:**
- Consumes: the var names `ALLOWED_EMAIL_DOMAINS` and `SESSION_MAX_AGE_HOURS` established in Task 1.
- Produces: `AuthConfig.allowedEmailDomains?: string[]` and `AuthConfig.sessionMaxAgeHours?: number`, both optional so every existing `deployment.jsonc` and every fixture in the test file stays valid.

- [ ] **Step 1: Write the failing tests**

In `scripts/deploy/deployment-config.test.ts`, add to the backend-vars `describe` block (the one containing `"passes ADMINS as an array and enables the configured sign-in gatekeepers"`):

```ts
  it("omits the restriction vars when the deployment does not ask for them", () => {
    assert.equal(generated.vars?.ALLOWED_EMAIL_DOMAINS, undefined);
    assert.equal(generated.vars?.SESSION_MAX_AGE_HOURS, undefined);
  });

  it("passes an email allowlist and session max age to the backend", () => {
    const config = baseDeployment({
      admins: ["admin@contentstack.com"],
      auth: {
        gatekeepers: ["github"],
        disablePassword: true,
        allowedEmailDomains: ["contentstack.com"],
        sessionMaxAgeHours: 24,
      },
    });
    const out = generateProdConfig("workshop-backend", base("workshop-backend"), config);
    assert.equal(out.vars?.ALLOWED_EMAIL_DOMAINS, "contentstack.com");
    assert.equal(out.vars?.SESSION_MAX_AGE_HOURS, "24");
  });
```

And add to the validation `describe` block (the one containing `"rejects disabling passwords with no other way in"`):

```ts
  // Password accounts are keyed by username, so no email check can gate them: an allowlist with
  // password signup still open would be a restriction anyone could walk around.
  // Note the in-domain admin in these two: baseDeployment's default admin is admin@example.com,
  // which the allowlist would separately reject, and that error also mentions allowedEmailDomains.
  // Pinning the admin keeps each case failing for the one reason it is testing.
  it("rejects an email allowlist while password signup is still open", () => {
    const config = baseDeployment({
      admins: ["admin@contentstack.com"],
      auth: {
        gatekeepers: ["github"], disablePassword: false,
        allowedEmailDomains: ["contentstack.com"],
      },
    });
    const errors = validateDeployment(config, ROOT);
    assert.ok(errors.some(e => e.includes("cannot be domain-restricted")), errors.join("\n"));
  });

  it("rejects a malformed entry in the email allowlist", () => {
    const config = baseDeployment({
      admins: ["admin@contentstack.com"],
      auth: {
        gatekeepers: ["github"], disablePassword: true,
        allowedEmailDomains: ["@contentstack.com"],
      },
    });
    const errors = validateDeployment(config, ROOT);
    assert.ok(errors.some(e => e.includes("bare domain")), errors.join("\n"));
  });

  // An admin who cannot sign in is a footgun that only surfaces when someone needs /admin.
  it("rejects an admin outside the email allowlist", () => {
    const config = baseDeployment({
      admins: ["admin@example.com"],
      auth: {
        gatekeepers: ["github"], disablePassword: true,
        allowedEmailDomains: ["contentstack.com"],
      },
    });
    const errors = validateDeployment(config, ROOT);
    assert.ok(errors.some(e => e.includes("cannot sign in")), errors.join("\n"));
  });

  it("rejects a non-positive session max age", () => {
    const config = baseDeployment({
      auth: { gatekeepers: ["github"], disablePassword: false, sessionMaxAgeHours: 0 },
    });
    const errors = validateDeployment(config, ROOT);
    assert.ok(errors.some(e => e.includes("sessionMaxAgeHours")), errors.join("\n"));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/deploy/deployment-config.test.ts`
Expected: FAIL — the new `auth` fields are not on the type (a `tsc` failure under `pnpm types:scripts`, and at runtime the vars are simply absent and no validation errors are produced).

- [ ] **Step 3: Extend `AuthConfig` in `scripts/deploy/deployment-config.ts`**

Add to the interface, after `disablePassword`:

```ts
  /**
   * Email domains permitted to sign in, e.g. `["contentstack.com"]`. Matched exactly against the
   * provider-verified email's domain, so subdomains need listing of their own. Omit to let any
   * address in. Setting this requires `disablePassword`, because password accounts are keyed by
   * username and no email check can gate them.
   */
  allowedEmailDomains?: string[];
  /**
   * How long a session lasts before the user must sign in again, in hours. Omit for sessions that
   * never expire. A bounded session is what makes `allowedEmailDomains` -- and the identity
   * provider's own offboarding -- keep counting after the first sign-in.
   */
  sessionMaxAgeHours?: number;
```

- [ ] **Step 4: Emit the vars in `applyBackendConfig`**

Replace the existing auth block:

```ts
  if (config.auth.gatekeepers.length > 0) {
    vars.AUTH_GATEKEEPERS = config.auth.gatekeepers.join(",");
    if (config.auth.disablePassword) vars.DISABLE_PASSWORD_AUTH = "true";
  }
  if (config.auth.allowedEmailDomains?.length) {
    vars.ALLOWED_EMAIL_DOMAINS = config.auth.allowedEmailDomains.join(",");
  }
  if (config.auth.sessionMaxAgeHours !== undefined) {
    vars.SESSION_MAX_AGE_HOURS = String(config.auth.sessionMaxAgeHours);
  }
```

- [ ] **Step 5: Add the four validation rules in `validateAuth`**

Insert before the closing `return errors;`:

```ts
  const domains = config.auth.allowedEmailDomains ?? [];
  for (const domain of domains) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      errors.push(
        `auth.allowedEmailDomains contains "${domain}", which is not a lowercase bare domain ` +
        "like \"contentstack.com\" -- no \"@\", no leading dot, no whitespace");
    }
  }
  // Password accounts are keyed by username rather than email, so an allowlist cannot gate them.
  // The backend refuses password auth outright once an allowlist is set; saying so here means the
  // config states what it does rather than being silently overridden.
  if (domains.length > 0 && !config.auth.disablePassword) {
    errors.push(
      "auth.allowedEmailDomains is set but auth.disablePassword is not; password accounts are " +
      "keyed by username, so they cannot be domain-restricted and would bypass the allowlist");
  }
  if (domains.length > 0) {
    const locked = (config.admins ?? []).filter(admin => {
      const at = admin.lastIndexOf("@");
      return at < 0 || !domains.includes(admin.slice(at + 1).toLowerCase());
    });
    for (const admin of locked) {
      errors.push(
        `admins lists "${admin}", which auth.allowedEmailDomains cannot sign in; that admin ` +
        "would never be able to reach /admin");
    }
  }
  if (config.auth.sessionMaxAgeHours !== undefined
      && !(Number.isFinite(config.auth.sessionMaxAgeHours) && config.auth.sessionMaxAgeHours > 0)) {
    errors.push(
      `auth.sessionMaxAgeHours must be a positive number of hours, not ` +
      `${config.auth.sessionMaxAgeHours}; the backend ignores anything else, leaving sessions ` +
      "that never expire");
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/deploy/deployment-config.test.ts`
Expected: PASS — including every pre-existing case, since both fields are optional.

- [ ] **Step 7: Document both fields in the tracked template**

`deployment.example.jsonc` is what every reader starts from, and `deployment-config.test.ts` asserts
it still validates — allowing only errors that name a `<PLACEHOLDER>`. So the fields go in
**commented out**: writing `"allowedEmailDomains": ["contentstack.com"]` into a template that also
says `"disablePassword": false` would produce a real validation error and turn that test red.

In `deployment.example.jsonc`, inside the `auth` block after the `disablePassword` entry:

```jsonc
    // Optional: restrict sign-in to these email domains, matched exactly against the
    // provider-verified address (no subdomains -- list one per domain you mean). Setting this
    // requires disablePassword: password accounts are keyed by username, so no email check can
    // gate them, and the backend refuses password auth outright once this is set.
    // "allowedEmailDomains": ["example.com"],

    // Optional: how long a session lasts before the user signs in again, in hours. Omitted means
    // sessions never expire -- which also means removing someone at your identity provider does
    // not end their access here, since the provider is never consulted again after the first
    // sign-in.
    // "sessionMaxAgeHours": 24
```

Run: `node --test scripts/deploy/deployment-config.test.ts`
Expected: PASS, including "deployment.example.jsonc parses, and fails validation only on its own
placeholders".

- [ ] **Step 8: Pass both vars through to local dev**

In `scripts/run-dev-server.ts`, extend `OPTIONAL_FEATURE_VARS` — add `"ALLOWED_EMAIL_DOMAINS"` and `"SESSION_MAX_AGE_HOURS"` to the first line of the list, next to `"DISABLE_PASSWORD_AUTH", "AUTH_GATEKEEPERS"`.

Then in `.env.example`, immediately after the `DISABLE_PASSWORD_AUTH=true` block:

```
# Comma-separated email domains permitted to sign in, matched exactly against the provider-verified
# address (no subdomains). Empty = unrestricted. Setting this also disables password auth outright:
# password accounts are keyed by username, so no email check can gate them.
# ALLOWED_EMAIL_DOMAINS=contentstack.com

# How long a session lasts before the user signs in again, in hours. Unset = never expires. This is
# what makes ALLOWED_EMAIL_DOMAINS keep counting after the first sign-in -- without it, a token
# issued once works forever no matter what the identity provider says later.
# SESSION_MAX_AGE_HOURS=24
```

- [ ] **Step 9: Verify the scripts suite and types**

Run: `node --test 'scripts/**/*.test.ts' && pnpm types:scripts`
Expected: PASS.

- [ ] **Step 10: Confirm the other two resolutions of these vars are genuinely untouched**

The spec calls for confirming, not assuming, that this change stops where it should.

Run: `node --test scripts/release/manifest-lib.test.ts`
Expected: PASS with no golden-file diff. Backend instance-state vars are injected by the deploy
service at PUT time rather than templated into the manifest — `AUTH_GATEKEEPERS` and
`DISABLE_PASSWORD_AUTH` do not appear in `manifest-lib.ts` either. **If this test does fail, stop.**
A moved golden file means these vars reach customer instances through the release manifest, which is
a decision to make deliberately, not a file to regenerate.

Run: `grep -n "ALLOWED_EMAIL_DOMAINS\|SESSION_MAX_AGE_HOURS" scripts/preview/staging-config.ts`
Expected: no matches. Staging authenticates via Cloudflare Access and sets no auth vars, so it is
unaffected — but this change does touch `authenticateFromCfAccess()`, so an allowlist leaking into a
staging config would gate Access sign-in there too.

- [ ] **Step 11: Commit**

```bash
git add scripts/deploy/deployment-config.ts deployment.example.jsonc scripts/deploy/deployment-config.test.ts \
        scripts/run-dev-server.ts .env.example
git commit -m "feat(deploy): configure the email allowlist and session max age per deployment"
```

---

### Task 5: Fork ledger and documentation

Neither behaviour has an upstream counterpart, which makes them exactly what an upstream merge reverts silently — a file upstream changes and the fork does not, auto-merging cleanly with nothing failing. Both get a ratchet.

**Files:**
- Modify: `scripts/fork-intent.test.ts` (append an F8 group to `INTENTS`, after F7.5)
- Modify: `docs/fork-delta.md` (append an F8 group to the Held table, after F7.5)
- Modify: `docs/oauth-signin.md` (Configuration section, and a new section)
- Modify: `CLOUDFLARE_SETUP.md` (the `auth` block ~line 194, the settings-mapping table ~line 502, the verification checklist ~line 396)
- Modify: `docs/self-hosting.md` (the deployment-description section)
- Modify: `CLAUDE.md:37` and `AGENTS.md:45` (the sentence listing the env-driven auth settings)

**Interfaces:**
- Consumes: every symbol and file path introduced in Tasks 1–4.
- Produces: fork intents F8.1–F8.5.

- [ ] **Step 1: Write the failing fork-intent assertions**

In `scripts/fork-intent.test.ts`, append to the `INTENTS` array, after the F7.5 entry:

```ts
  // ---- F8  Deployment-scoped sign-in restriction --------------------------------------------
  // Upstream's sign-in is open to anyone the provider will vouch for, and its sessions never
  // expire. This deployment admits one email domain and re-checks with the provider on a schedule.
  { id: 'F8.1', intent: 'every email-keyed entry point enforces the domain allowlist',
    holds: () => matches('packages/workshop-backend/src/auth/login-flow.ts', /isEmailAllowed/)
              && matches('packages/workshop-backend/src/server.ts', /isEmailAllowed/) },
  // The `has` check is load-bearing: matches() reports false for a missing file, so a bare
  // negation would pass vacuously if admin-config.ts were ever renamed.
  { id: 'F8.2', intent: 'the allowlist is env-driven, never part of AdminConfig',
    holds: () => matches('packages/workshop-backend/src/auth/config.ts', /ALLOWED_EMAIL_DOMAINS/)
              && has('packages/workshop-backend/src/admin-config.ts')
              && !matches('packages/workshop-backend/src/admin-config.ts', /ALLOWED_EMAIL_DOMAINS/) },
  { id: 'F8.3', intent: 'a configured allowlist disables password auth, failing closed not open',
    holds: () => matches('packages/workshop-backend/src/auth/config.ts',
                         /getAllowedEmailDomains\(env\)\.length > 0\) return false/) },
  { id: 'F8.4', intent: 'session tokens expire against a configurable maximum age',
    holds: () => matches('packages/workshop-backend/src/user.ts', /getSessionMaxAgeMs/) },
  { id: 'F8.5', intent: 'the deploy harness rejects a config whose admins cannot sign in',
    holds: () => matches('scripts/deploy/deployment-config.ts', /would never be able to reach/) },
```

- [ ] **Step 2: Run to verify the ledger check fails**

Run: `node --test scripts/fork-intent.test.ts`
Expected: FAIL on "docs/fork-delta.md accounts for every asserted intent" — F8.1–F8.5 are asserted but absent from the ledger. The intents themselves should already hold, since Tasks 1–4 are done.

- [ ] **Step 3: Add the ledger rows**

In `docs/fork-delta.md`, append to the Held table after the F7.5 row:

```markdown
| **F8** | **A deployment-scoped sign-in restriction** | |
| F8.1 | Every email-keyed entry point enforces the domain allowlist | `workshop-backend/src/auth/login-flow.ts`, `workshop-backend/src/server.ts` |
| F8.2 | The allowlist is env-driven, never part of `AdminConfig` | `workshop-backend/src/auth/config.ts` |
| F8.3 | A configured allowlist disables password auth, failing closed rather than open | `workshop-backend/src/auth/config.ts` |
| F8.4 | Session tokens expire against a configurable maximum age | `workshop-backend/src/user.ts` |
| F8.5 | The deploy harness rejects a config whose admins cannot sign in | `scripts/deploy/deployment-config.ts` |
```

- [ ] **Step 4: Run to verify the assertions pass**

Run: `node --test scripts/fork-intent.test.ts`
Expected: PASS — all three fork-intent tests green.

- [ ] **Step 5: Document both settings in `docs/oauth-signin.md`**

Extend the fenced Configuration block:

```
PUBLIC_BASE_URL=https://your-host
AUTH_GATEKEEPERS=cloudflare,google,github   # which gatekeepers may sign users in (order = button order)

# Optional: gatekeeper sign-in only (hide username/password).
DISABLE_PASSWORD_AUTH=true

# Optional: restrict sign-in to one or more email domains, and bound how long a session lasts.
ALLOWED_EMAIL_DOMAINS=contentstack.com
SESSION_MAX_AGE_HOURS=24
```

Then add a section after "Identity: keyed by verified email":

```markdown
## Restricting who may sign in

`ALLOWED_EMAIL_DOMAINS` limits sign-in to a set of email domains, matched **exactly** (no
wildcards, no subdomains) against the provider-verified address. It is enforced in
`LoginConnectCallbackImpl.complete()` — ahead of resolving the user DO, so a refused address leaves
no account behind — and again on the Cloudflare Access path, so there is no second door.

Two consequences are deliberate:

- **A domain allowlist disables password auth outright**, overriding the usual "ignored unless a
  gatekeeper is allowlisted" rule. Password accounts are keyed by username, not email, so no domain
  check can gate them; leaving password signup open would void the allowlist. A misconfigured
  deployment therefore refuses everyone rather than quietly admitting strangers.
- **`SESSION_MAX_AGE_HOURS` is what makes the restriction stick.** The domain check runs at login;
  without an expiry, a token issued once works forever and the identity provider is never consulted
  again — so offboarding someone there would not end their access here. The lifetime is absolute
  from issue time rather than idle-based, because an idle timeout would never expire for an active
  user, which is precisely the case that matters.

An email domain is not proof of organisation membership: a consumer Google account can be registered
against a company address, and the gatekeeper reads the verified `email` claim without inspecting
`hd`. When the guarantee has to be organisation membership, register the OAuth app as **Internal**
to the workspace so the provider refuses outside accounts before we ever see them.
```

- [ ] **Step 6: Record this deployment's posture in `CLOUDFLARE_SETUP.md`**

Update the `auth` block (~line 194) to:

```jsonc
"auth": {
  "gatekeepers": ["google"],
  "disablePassword": true,
  "allowedEmailDomains": ["contentstack.com"],
  "sessionMaxAgeHours": 24
}
```

Keep the existing note that `disablePassword` should stay `false` for the first deploy, and extend it: `allowedEmailDomains` and `sessionMaxAgeHours` go in with it, in the second deploy, because `deploy:check` refuses an allowlist while password auth is still open.

Add to the settings-mapping table (~line 502), after the `auth.disablePassword` row:

```markdown
| `auth.allowedEmailDomains` | backend `ALLOWED_EMAIL_DOMAINS` |
| `auth.sessionMaxAgeHours` | backend `SESSION_MAX_AGE_HOURS` |
```

Add below the OAuth redirect-URI table (~line 341):

```markdown
> **Register the Google app as Internal** to the Contentstack workspace. `allowedEmailDomains`
> checks the domain of the address Google reports as verified, and a *consumer* Google account can
> be registered against a company address — including one whose workspace account has since been
> deleted. Internal is what makes `@contentstack.com` mean workspace membership rather than an
> address that merely ends in those characters, because Google then refuses outside accounts before
> the Workshop ever sees them.
```

Add to the verification checklist (~line 396):

```markdown
- [ ] Sign in with a non-`@contentstack.com` Google account: the popup reports
      "Only @contentstack.com accounts can sign in to this deployment." and no account is created.
- [ ] The password form is gone from both the login and signup pages.
```

- [ ] **Step 7: Note the fields in `docs/self-hosting.md`**

In the section describing what `deployment.jsonc` holds, add:

```markdown
The `auth` block also carries who may sign in and for how long: `allowedEmailDomains` restricts
sign-in to an exact set of email domains (and requires `disablePassword`, since password accounts
are keyed by username and cannot be domain-checked), and `sessionMaxAgeHours` bounds how long a
session lasts before the provider is consulted again. Omit both for upstream behaviour — anyone the
provider vouches for, in a session that never expires.
```

- [ ] **Step 8: Extend the repo instructions in `CLAUDE.md` and `AGENTS.md`**

Both files carry the same sentence naming exactly which authentication settings are env-driven, and
an agent reading either one would otherwise conclude the list is complete. In `CLAUDE.md` (~line 37)
and `AGENTS.md` (~line 45), replace the parenthetical

`(sign-in providers via `AUTH_GATEKEEPERS`, password login via `DISABLE_PASSWORD_AUTH`)`

with

`(sign-in providers via `AUTH_GATEKEEPERS`, password login via `DISABLE_PASSWORD_AUTH`, who may sign in via `ALLOWED_EMAIL_DOMAINS`, and how long a session lasts via `SESSION_MAX_AGE_HOURS`)`

Leave the rest of each sentence, and each file's differing bullet style, untouched.

- [ ] **Step 9: Run the full gate**

Run: `pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add scripts/fork-intent.test.ts docs/fork-delta.md docs/oauth-signin.md \
        CLOUDFLARE_SETUP.md docs/self-hosting.md CLAUDE.md AGENTS.md
git commit -m "docs: record the sign-in restriction and its fork intents"
```

---

### Task 6: Point this deployment at Google only

Everything above is deployment-agnostic and committed. This task edits the gitignored
`deployment.jsonc`, which describes *this* instance, and validates it without touching Cloudflare.

**Files:**
- Modify: `deployment.jsonc` (untracked — nothing to commit)

**Interfaces:**
- Consumes: the `auth` fields from Task 4 and the validation rules from Task 4 Step 5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Take GitHub off the sign-in list**

In `deployment.jsonc`, set `auth.gatekeepers` to `["google"]`. Leave `gatekeeper-github` in the
`workers` map: GitHub remains available as a connector for repos and issues, it just cannot sign
anyone in. Leave `disablePassword` at `false` and add nothing else yet — this is the configuration
for the first of the two deploys.

- [ ] **Step 2: Validate**

Run: `pnpm deploy:check`
Expected: PASS, with no network calls. The generated backend config should carry
`AUTH_GATEKEEPERS: "google"` and no `ALLOWED_EMAIL_DOMAINS`.

- [ ] **Step 3: Confirm the restricted configuration validates too**

Temporarily add to `auth`: `"disablePassword": true`, `"allowedEmailDomains": ["contentstack.com"]`,
`"sessionMaxAgeHours": 24`.

Run: `pnpm deploy:check`
Expected: PASS. Then check the guardrails fire — remove `"disablePassword": true` and re-run;
expected: FAIL naming `auth.allowedEmailDomains`. Restore it.

- [ ] **Step 4: Revert to the step-1 configuration**

Take `disablePassword`, `allowedEmailDomains` and `sessionMaxAgeHours` back out. They go in after
Google sign-in is verified working against the deployed instance — see the handoff below. Nothing
here is committed; `deployment.jsonc` is gitignored.

---

## Deploying (operator, after the plan is implemented)

**Not part of the plan's tasks — these steps change cloud state and need an explicit go-ahead.**

1. Create the Google OAuth app in the Contentstack Google account: user type **Internal**, redirect
   URI `https://cs-os-router.lytics-demandbase.workers.dev/gatekeeper/google/oauth`, scopes
   `openid email profile`. Put the client id and secret in the gitignored `.deploy.vars` under the
   `gatekeeper-google` key.
2. `pnpm deploy` with the step-1 configuration (Google listed, password auth still on). Verify
   "Continue with Google" works end to end and that `/admin` is reachable as
   `pradeep.mishra@contentstack.com`.
3. Add `disablePassword: true`, `allowedEmailDomains: ["contentstack.com"]` and
   `sessionMaxAgeHours: 24`, then `pnpm deploy` again.
4. Verify: a non-`@contentstack.com` Google account is refused with the expected message and creates
   no account; the password form is gone from both pages.

Rolling back means removing all three fields together and redeploying the backend — the deploy-time
rule and the runtime fail-closed rule both require the allowlist to be gone before password auth
returns. That is why step 2 exists.
