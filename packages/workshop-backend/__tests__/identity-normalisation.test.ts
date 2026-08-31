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

  it("returns false with no name or no configured admins", () => {
    expect(isAdminUser({ ADMINS: ["a@example.com"] }, "")).toBe(false);
    expect(isAdminUser({}, "a@example.com")).toBe(false);
  });

  it("accepts ADMINS as a JSON-array string binding", () => {
    expect(isAdminUser({ ADMINS: "[\"A@Example.com\"]" }, "a@example.com")).toBe(true);
  });

  it("throws on a malformed ADMINS binding, matching the original #isAdmin() behaviour", () => {
    // Valid JSON, but not an array — the original #isAdmin() rejects this the same way.
    expect(() => isAdminUser({ ADMINS: "{}" as unknown as string[] }, "a@example.com"))
      .toThrow(TypeError);
  });
});
