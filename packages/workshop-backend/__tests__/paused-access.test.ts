import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { AUTH_ERROR_CODES, AUTH_ERROR_MESSAGES } from "@gadgets/workshop-shared/api";
import { isBlockedByPause } from "../src/auth/admin.js";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";

describe("isBlockedByPause", () => {
  it("admits everyone when not paused", () => {
    expect(isBlockedByPause({ ADMINS: ["admin@example.com"] }, false, "anyone@example.com"))
      .toBe(false);
  });

  it("denies a non-admin while paused", () => {
    expect(isBlockedByPause({ ADMINS: ["admin@example.com"] }, true, "person@example.com"))
      .toBe(true);
  });

  // The lockout: an admin must always be able to sign in while paused, or nobody could ever
  // resume the deployment.
  it("admits an admin while paused", () => {
    expect(isBlockedByPause({ ADMINS: ["Admin@Example.com"] }, true, "admin@example.com"))
      .toBe(false);
  });

  // Finding 4: a malformed ADMINS must not become an open door. isAdminUser throws a TypeError
  // here; that must deny rather than propagate.
  it("denies a non-admin when the admin check throws", () => {
    expect(isBlockedByPause({ ADMINS: "not-json" as unknown as string[] }, true, "person@example.com"))
      .toBe(true);
  });
});

// complete() reads the deployment's admin-config from KV. Stubbing it keeps this test to the
// question it is asking -- who may sign in while paused -- and needs no KV binding.
const readAdminConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../src/admin-config.js", () => ({ readAdminConfig: readAdminConfigMock }));

/** The calls complete() makes, recorded by the fakes below. */
type Recorder = {
  failures: string[];
  delivered: string[];
  logins: string[];
};

/**
 * Build a callback wired to fakes for the two Durable Objects it reaches through `ctx.exports`.
 * `LoginConnectCallbackImpl` is a plain WorkerEntrypoint subclass, so constructing it directly with
 * a hand-built ctx is the cheapest way to exercise complete() without an OAuth round trip. Mirrors
 * the harness in login-domain-allowlist.test.ts.
 */
function makeCallback(env: Record<string, unknown>): {
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
  const callback = new LoginConnectCallbackImpl(
      ctx as unknown as ExecutionContext, env as unknown as Cloudflare.Env);

  return {
    recorder,
    complete: (email) => callback.complete(
        { getAuthenticatedEmail: async () => email } as unknown as Fetcher<GatekeeperUser>),
  };
}

describe("gatekeeper login while the deployment is paused", () => {
  const admin = { ADMINS: ["admin@contentstack.com"] };

  it("refuses gatekeeper sign-in for a non-admin while paused", async () => {
    readAdminConfigMock.mockResolvedValue({ signupsEnabled: true, paused: true });
    const { complete, recorder } = makeCallback(admin);

    await complete("user@contentstack.com");

    expect(recorder.failures)
      .toEqual([AUTH_ERROR_MESSAGES[AUTH_ERROR_CODES.deploymentPaused]]);
    expect(recorder.delivered).toEqual([]);
    expect(recorder.logins).toEqual([]);
  });

  it("admits an admin while paused", async () => {
    readAdminConfigMock.mockResolvedValue({ signupsEnabled: true, paused: true });
    const { complete, recorder } = makeCallback(admin);

    await complete("admin@contentstack.com");

    expect(recorder.delivered).toEqual(["admin@contentstack.com:session-secret"]);
    expect(recorder.failures).toEqual([]);
  });

  it("admits everyone once resumed", async () => {
    readAdminConfigMock.mockResolvedValue({ signupsEnabled: true, paused: false });
    const { complete, recorder } = makeCallback(admin);

    await complete("user@contentstack.com");

    expect(recorder.delivered).toEqual(["user@contentstack.com:session-secret"]);
    expect(recorder.failures).toEqual([]);
  });

  // A malformed ADMINS binding must fail the pending login cleanly rather than hang the browser.
  // isBlockedByPause swallows the throw internally, so complete() reaches pending.fail() with the
  // paused message instead of falling into the generic outer catch.
  it("fails the pending login cleanly when the admin check throws", async () => {
    readAdminConfigMock.mockResolvedValue({ signupsEnabled: true, paused: true });
    const { complete, recorder } = makeCallback({ ADMINS: "not-json" });

    await complete("user@contentstack.com");

    expect(recorder.failures)
      .toEqual([AUTH_ERROR_MESSAGES[AUTH_ERROR_CODES.deploymentPaused]]);
    expect(recorder.delivered).toEqual([]);
  });
});
