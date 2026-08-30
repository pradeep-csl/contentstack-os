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
