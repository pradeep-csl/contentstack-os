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
