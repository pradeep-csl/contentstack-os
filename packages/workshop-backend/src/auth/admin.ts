// Identity normalisation and admin-matching for sign-in.
//
// A verified email is used verbatim as the user Durable Object's name and is compared verbatim
// against ADMINS. Providers do not agree on casing, so both uses must go through the same
// normalisation or one person ends up with two accounts, and a mixed-case admin silently loses
// access to /admin.

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

/**
 * Whether `userName` (the authenticated user DO's name) is listed in the deployment's `ADMINS`.
 *
 * Carries the same parsing as historical `#isAdmin()` — including throwing a `TypeError` on a
 * malformed `ADMINS` binding — with one change: both sides are compared through
 * {@link normalizeSignInEmail}, so an admin listed in one case still matches a provider that
 * verifies the address in another.
 */
export function isAdminUser(env: Pick<Cloudflare.Env, "ADMINS">, userName: string): boolean {
  let admins = env.ADMINS;

  if (!userName || !admins) return false;

  if (typeof admins === "string") {
    // Admins should be a JSON binding of array type, but `.env` doesn't actually let you
    // specify JSON bindings, so we also support a string that parses as JSON array.
    admins = JSON.parse(admins);
  }

  if (!Array.isArray(admins)) {
    throw new TypeError("ADMINS must be configured as an array of usernames.");
  }

  const name = normalizeSignInEmail(userName);
  return admins.some(admin => normalizeSignInEmail(admin) === name);
}
