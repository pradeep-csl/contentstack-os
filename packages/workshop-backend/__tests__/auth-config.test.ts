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
