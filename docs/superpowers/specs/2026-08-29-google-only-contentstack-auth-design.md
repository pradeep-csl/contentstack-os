# Google-only sign-in, restricted to @contentstack.com

**Date:** 2026-08-29
**Status:** approved after critical review, ready for an implementation plan

## Goal

This deployment should have exactly one way in: **Continue with Google**, using a
`@contentstack.com` account. Username/password signup and login go away, the GitHub sign-in button
goes away, and an email outside the allowed domain cannot create an account or sign in — whatever
provider it arrives through.

GitHub survives as a **connector**: `gatekeeper-github` stays deployed and bound, so a user can
still connect a GitHub account for repos and issues. It just cannot sign anyone in.

Google is the authority on who works here, so access has to keep asking it. A session issued today
must not still be valid after the account behind it is gone.

## What already works, and what does not

Two thirds of this is configuration that the repo already supports.

| Requirement | Mechanism | New code? |
| --- | --- | --- |
| Google is the only sign-in button | `AUTH_GATEKEEPERS=google` | No |
| GitHub cannot sign anyone in | absent from `AUTH_GATEKEEPERS`; `startGatekeeperLogin` rejects unlisted vendors server-side | No |
| No password login or signup | `DISABLE_PASSWORD_AUTH=true`; `login()` and `createAccount()` both throw | No |
| Only `@contentstack.com` may sign in | — nothing exists | **Yes** |
| Access stops when the Google account does | — sessions never expire | **Yes** |

The gaps are the domain restriction and session lifetime. Everything below is built around closing
them without disturbing the parts that already work.

### Why session lifetime is part of this change

The domain check runs at **login**. `UserDurableObject.authenticate()` then validates a session
token by checking only that its record exists — the record carries `created`, but nothing reads it,
and `AdminApi` has no revoke-user or revoke-sessions method. A token, once issued, works forever.

That would leave the headline guarantee false in the case that matters most: removing someone from
the Contentstack Workspace, or dropping a domain from the allowlist, would not end their access,
because after the first sign-in nothing ever asks Google again. A bounded session lifetime is what
makes Google's answer keep counting.

## Design

### 1. Deployment configuration

`deployment.jsonc` (untracked) and `deployment.example.jsonc` (tracked) change together:

```jsonc
"auth": {
  "gatekeepers": ["google"],
  "disablePassword": true,
  "allowedEmailDomains": ["contentstack.com"],
  "sessionMaxAgeHours": 24
},
"workers": {
  // gatekeeper-github stays: connector only, no longer a sign-in provider
  "gatekeeper-github": "os-github",
  "gatekeeper-google": "os-google"
}
```

`AuthConfig` in `scripts/deploy/deployment-config.ts` gains two optional fields, emitted by
`applyBackendConfig`:

- `allowedEmailDomains: string[]` → `vars.ALLOWED_EMAIL_DOMAINS = domains.join(",")`, the same
  comma-separated shape as the neighbouring `AUTH_GATEKEEPERS`, so the two read alike in a generated
  config.
- `sessionMaxAgeHours: number` → `vars.SESSION_MAX_AGE_HOURS = String(hours)`. Omitted entirely when
  unset, so a deployment that says nothing keeps upstream's never-expiring sessions.

`validateAuth` gains four rules:

- **Each entry is a bare domain.** Lowercase, non-empty, no `@`, no leading or trailing dot, no
  whitespace. A typo like `"@contentstack.com"` must fail `pnpm deploy:check`, not silently reject
  every user at 3am.
- **A domain allowlist requires `disablePassword: true`.** This one is load-bearing rather than
  tidy: password accounts are keyed by *username*, not by email, so no domain check can gate them.
  Allowing both at once would present a restriction that a password signup walks straight around.
  Fail closed at config time.
- **Every `admins` entry must satisfy the allowlist.** Otherwise a config can name an admin who can
  never sign in — silently, and only discovered when someone needs `/admin`.
- **`sessionMaxAgeHours`, if present, is a positive number.** Zero or negative would expire every
  session the instant it is issued.

### 2. Backend enforcement

**`packages/workshop-backend/src/auth/config.ts`** — where the deployment's other authn switches
already live, deliberately env-driven rather than in `AdminConfig`, so a compromised admin session
cannot widen who may sign in:

- `getAllowedEmailDomains(env): string[]` — parses `ALLOWED_EMAIL_DOMAINS`, trimmed and lowercased,
  empty when unset.
- `isEmailAllowed(email, env): boolean` — true when the list is empty (unrestricted, the upstream
  default), otherwise an exact match on the domain after the **last** `@`, compared lowercased.
- `getSessionMaxAgeMs(env): number | null` — parses `SESSION_MAX_AGE_HOURS`, null when unset or
  unparseable.

Exact match, no wildcards. `sub.contentstack.com`, `evilcontentstack.com` and
`contentstack.com.evil.example` all fail. A subdomain that ever needs access is added to the list
explicitly.

`isPasswordAuthEnabled()` gains one clause: **a configured domain allowlist disables password auth
outright**, regardless of `DISABLE_PASSWORD_AUTH` or the allowlist-is-empty escape hatch. Upstream
deliberately fails *open* there (password auth stays on when no gatekeeper is configured, so a
misconfiguration cannot lock everyone out). That default is wrong once a domain restriction exists:
password accounts are username-keyed and therefore ungatable, so failing open would silently reopen
unrestricted signup — the exact thing the deployment set out to prevent. A misconfiguration should
lock everyone out and be fixed, not quietly admit strangers. The deploy-time rule above makes the
bad combination unreachable from a generated config; this makes it unreachable at runtime too.

**`packages/workshop-backend/src/auth/login-flow.ts`** — the single chokepoint every gatekeeper
login passes through. In `LoginConnectCallbackImpl.complete()`, after `getAuthenticatedEmail()`
returns and **before** `loginOrCreateViaGatekeeper` resolves or creates a user DO:

```ts
if (!isEmailAllowed(email, this.env)) {
  loginLogger.info("gatekeeper login finished", {
    event: "gatekeeper.login.finished", outcome: "domain_not_allowed",
  });
  await pending.fail("Only @contentstack.com accounts can sign in to this deployment.");
  return;
}
```

Placement before account creation is the point: a rejected email leaves no DO behind. The failure
rides the existing `pending.fail` path, so the message lands in the login pop-up flow with no
frontend change. The message names the allowed domain rather than saying "not allowed" — a user who
picked the wrong Google profile needs to know which one to pick.

The log line reuses the existing `gatekeeper.login.finished` event with a new `outcome`, matching
the `no_email` and `signups_disabled` outcomes beside it. The rejected address is **not** logged.

**`packages/workshop-backend/src/server.ts`** — `authenticateFromCfAccess()` is the other
email-keyed entry point that resolves-or-creates a user DO. This deployment does not use Cloudflare
Access, but leaving a second door ungated is exactly what the kernel bar exists to prevent, so it
gets the same check before `authenticateFromCfAccess(email, signupsEnabled)`.

**`packages/workshop-backend/src/env.d.ts`** — declare `ALLOWED_EMAIL_DOMAINS?: string` and
`SESSION_MAX_AGE_HOURS?: string` in the optional-features block, documented like their neighbours.

The domain check is **not** added to `PublicApi.authenticate()`. It could be — session tokens are
`"<email>:<secret>"`, so the prefix is the email — but bounded sessions (below) achieve the same
revocation property without putting an allowlist lookup on the reconnect path or silently locking
out any username-keyed account that might exist.

### 3. Session lifetime

`UserDurableObject.authenticate()` is the single point every session validation passes through, for
both the initial `PublicApi.authenticate()` and every WebSocket reconnect. After the existing
"session record exists" check:

```ts
const maxAgeMs = getSessionMaxAgeMs(this.env);
if (maxAgeMs !== null && Date.now() - session.created.getTime() > maxAgeMs) {
  this.storage.sessions.delete(tokenId);
  throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
}
```

**Absolute, not sliding.** An idle timeout is friendlier, but it would defeat the purpose: someone
using the app daily would never re-verify, so a departed employee with a live browser keeps access
indefinitely. An absolute lifetime from issue time forces a fresh Google check every N hours, which
is the whole point.

The user-visible cost is bounded. Sessions are validated at connect time — page load or reconnect —
not per request, so a connected tab is not interrupted mid-task, and re-authenticating is one click
against a Google session that is usually still alive. `SESSION_MAX_AGE_HOURS` is the knob if 24
hours proves annoying; raising it is a config edit plus a backend redeploy.

Deleting the expired record on the way out also prunes the `sessions` collection, which currently
grows without bound — nothing removes session records today.

No frontend work. `AUTH_ERROR_CODES.invalidSessionToken` is already classified as a terminal `auth`
error that only a fresh login cures, which is exactly the desired behaviour. The user sees the login
screen rather than a "your session expired" message; better copy is a possible follow-up, not part
of this change.

Reusing `invalidSessionToken` rather than adding an expiry-specific code is deliberate: the client
behaviour is identical, and a distinct code would tell an unauthenticated caller *why* a token
failed.

`authenticateFromCfAccess()` is unaffected — Access sessions are carried by the Access JWT and its
own expiry, not by a session record.

### 4. Local dev

`ALLOWED_EMAIL_DOMAINS` and `SESSION_MAX_AGE_HOURS` join `OPTIONAL_FEATURE_VARS` in
`scripts/run-dev-server.ts`, so both can be exercised locally with a shell variable rather than only
after a deploy, and both are documented in `.env.example` alongside the other optional feature vars.

### 5. Other resolutions of the same config

CLAUDE.md names three places one binding topology is resolved (dev server, release manifest, deploy
harness). Plain vars have a fourth: `scripts/preview/staging-config.ts`.

- **Release manifest** — no change expected. Backend instance-state vars are injected by the deploy
  service at PUT time rather than templated; `AUTH_GATEKEEPERS` and `DISABLE_PASSWORD_AUTH` do not
  appear in `manifest-lib.ts` either. Confirm by running the golden-file manifest test and seeing it
  stay green; if it does move, that is a decision to make deliberately, not a golden file to
  regenerate on autopilot.
- **Staging preview** — authenticates via Cloudflare Access and sets neither auth var, so it is
  unaffected by both additions. Since this change does touch `authenticateFromCfAccess()`, confirm
  that in the diff rather than assuming it: an allowlist accidentally reaching a staging instance
  would gate Access sign-in there too.

### 6. Fork ledger

Neither the domain check nor bounded sessions have an upstream counterpart, which makes them exactly
the kind of thing an upstream merge reverts silently. They get a new **F8** group in
`scripts/fork-intent.test.ts` and matching rows in `docs/fork-delta.md`:

| Id | Intent |
| --- | --- |
| F8.1 | Sign-in enforces a deployment email-domain allowlist |
| F8.2 | The allowlist is env-driven, never part of `AdminConfig` |
| F8.3 | A configured allowlist disables password auth, failing closed rather than open |
| F8.4 | Session tokens expire against a configurable maximum age |
| F8.5 | The deploy harness rejects a config whose admins cannot sign in |

### 7. Tests

- **`auth/config` unit tests** for `isEmailAllowed`: empty list allows everything; exact match;
  uppercase input and uppercase config; `sub.contentstack.com`; `evilcontentstack.com`;
  `contentstack.com.evil.example`; an address with no `@`; an address with two `@`s (the last one
  wins); whitespace and empty entries in the var. For `isPasswordAuthEnabled`: an allowlist turns it
  off even with `DISABLE_PASSWORD_AUTH` unset and `AUTH_GATEKEEPERS` empty — the fail-closed case.
- **Session expiry**: a token older than the max age is rejected and its record removed; a younger
  one is accepted; an unset var never expires anything; a malformed var is treated as unset rather
  than as zero (which would expire everything).
- **`deployment-config.test.ts`**: both vars are emitted in the expected shape and omitted when
  unset; a malformed domain, an allowlist without `disablePassword`, an admin outside the allowlist,
  and a non-positive `sessionMaxAgeHours` are each an error.
- **`fork-intent.test.ts`**: the five F8 assertions.

### 8. Documentation

- `docs/oauth-signin.md` — both new vars in the Configuration block, and a short section on the
  allowlist: where it is enforced, why it is env-driven, why it disables password auth, and why
  bounded sessions are what make the restriction stick.
- `docs/self-hosting.md` and `deployment.example.jsonc` — the new `auth.allowedEmailDomains` and
  `auth.sessionMaxAgeHours` fields.
- `.env.example` — both vars, for local dev.
- `CLOUDFLARE_SETUP.md` — this deployment's actual posture: Google-only, `@contentstack.com` only,
  24-hour sessions, GitHub as a connector, and the Internal OAuth app requirement below.
- `docs/fork-delta.md` — the F8 rows.

## A limit worth stating plainly

**An email suffix is not proof of Workspace membership.** `getGoogleVerifiedEmail` returns any
address Google reports with `email_verified === true` and ignores the `hd` (hosted domain) claim
([google-api.ts:189-206](../../../packages/gatekeeper-google/src/google-api.ts#L189-L206)). A
*consumer* Google account registered against a `contentstack.com` address satisfies a suffix check —
including one belonging to someone whose Workspace account has since been deleted.

Creating the OAuth app as **Internal** is what closes this: Google then refuses to issue tokens to
accounts outside the Workspace, so `hd` never has to be inspected. That makes Internal a
**requirement of this design**, not a hardening nicety, and it belongs in `CLOUDFLARE_SETUP.md` in
those terms. If the app ever has to become External, this design needs the gatekeeper to surface and
verify `hd` before the suffix check means anything.

## Verified not to be holes

- **Share links.** `openGadget(id, shareKey)` is on `AuthenticatedApi`, so redeeming a share
  requires an account, and collaborator records resolve by profile id for users who already exist.
  No anonymous path creates a user DO, so the login gate covers collaborators.
- **Gatekeeper allowlisting.** `startGatekeeperLogin` rejects any vendor absent from
  `AUTH_GATEKEEPERS` server-side, so dropping GitHub from the list is sufficient — keeping the worker
  deployed as a connector does not leave a sign-in path open.

## Out of scope

- **Removing the password code paths.** The config flag is enforced server-side in both `login()`
  and `createAccount()`. Deleting the code would be a large kernel and frontend diff that conflicts
  on every upstream pull, in exchange for no additional guarantee.
- **An admin UI for the domain list, or for session lifetime.** Authn config stays out of
  `AdminConfig` by design.
- **Domain-restricting connectors.** A signed-in user can still connect a personal Gmail or GitHub
  account. That is data governance rather than authentication, and a separate decision.
- **A distinct "session expired" screen.** Expiry lands on the existing terminal-auth path, which
  shows the login page. Better copy is a possible follow-up.
- **Retroactive eviction.** Nothing has been deployed yet, so there are no out-of-domain accounts to
  remove. Bounded sessions are what handle the case going forward.

Accepted, deliberately: the rejection message names the allowed domain to an anonymous visitor. A
user who picked the wrong Google profile needs to know which one to pick, and the domain is not a
secret.

## Operational notes

**Google OAuth app** (created by the operator, in the Contentstack Google account):

- User type **Internal** — load-bearing, see the limit stated above
- Redirect URI `https://os.contentstacklabs.workers.dev/gatekeeper/google/oauth`
- Scopes: `openid email profile` for sign-in; the connector's fuller scopes are requested later, only
  when a user explicitly connects Google
- Client id and secret go in the gitignored `.deploy.vars` under the `gatekeeper-google` key — never
  in `deployment.jsonc`, which the harness regenerates and wrangler prints

**Admin access.** `admins` is already `["pradeep.mishra@contentstack.com"]`, and gatekeeper sign-in
keys users by verified email, so Google sign-in lands in `/admin` with no password bootstrap.

**Deploy in two steps.** With `disablePassword: true` and admin bootstrap running through Google, a
broken OAuth app means no way in at all. So:

1. Deploy with `gatekeepers: ["google"]`, password auth still on and no allowlist. Verify Google
   sign-in end to end and confirm `/admin` is reachable.
2. Then add `disablePassword: true`, `allowedEmailDomains` and `sessionMaxAgeHours`, and redeploy.

**If sign-in misbehaves afterwards**, recovery is reverting step 2 and redeploying the backend —
and it must be all of step 2: both the deploy-time validation and the runtime fail-closed rule mean
`allowedEmailDomains` has to be cleared for password auth to come back. Not a lockout, but a
redeploy rather than a toggle, which is why step 1 exists.
