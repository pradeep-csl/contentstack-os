import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

function username(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

// Mirrors open-gadget-rpc.test.ts's connect(): the full RPC session over the real fetch handler,
// since PublicApiImpl isn't exported for direct construction.
async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");

  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(
    publicApi: RpcStub<PublicApi>, prefix: string): Promise<{ username: string; token: string }> {
  const name = username(prefix);
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return { username: name, token };
}

async function setPaused(paused: boolean): Promise<void> {
  await exports.AdminSettings.getByName("").updateAdminConfig({ paused });
}

type MutableEnv = { ADMINS?: string[] | string };

describe("PublicApi.authenticate while the deployment is paused", () => {
  afterEach(async () => {
    await setPaused(false);
    delete (env as MutableEnv).ADMINS;
  });

  it("rejects a non-admin session while paused", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "nonadmin");
    await setPaused(true);

    await expect(publicApi.authenticate(account.token)).rejects.toThrow(/paused/i);
  });

  // The lockout: an admin must always be able to sign in while paused, or nobody could ever
  // resume the deployment.
  it("admits an admin while paused", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "admin");
    (env as MutableEnv).ADMINS = [account.username];
    await setPaused(true);

    await expect(publicApi.authenticate(account.token)).resolves.toBeDefined();
  });

  it("admits everyone once resumed", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "resumed");
    await setPaused(true);
    await setPaused(false);

    await expect(publicApi.authenticate(account.token)).resolves.toBeDefined();
  });

  // Finding 4: a malformed ADMINS must not become an open door -- isAdminUser throws, and that
  // must deny rather than surface as an unhandled 500.
  it("denies a non-admin when the admin check throws", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "malformed");
    (env as MutableEnv).ADMINS = "not-json";
    await setPaused(true);

    await expect(publicApi.authenticate(account.token)).rejects.toThrow(/paused/i);
  });
});
