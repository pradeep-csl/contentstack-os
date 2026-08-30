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
