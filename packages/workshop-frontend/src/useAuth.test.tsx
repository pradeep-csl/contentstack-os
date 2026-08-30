// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// `publicApi.authenticate()` is pipelined, so the stub it returns is truthy long before the server
// has accepted the token. Without watching that promise, a stored token the server rejects leaves
// the app rendering its authenticated shell, and the failure surfaces as unexplained errors on
// whatever the app happens to call first.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import { AUTH_ERROR_CODES, createAuthError, type PublicApi } from "@gadgets/workshop-shared/api";
import { useAuth } from "./useAuth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Stands in for the stub `authenticate()` returns. An `RpcPromise` is both the pending call and the
 * stub for its result, so the fake is a real promise carrying the capability's methods — using an
 * actual promise rather than a hand-rolled `then` keeps it a genuine thenable.
 */
function fakePublicApi(rejection: unknown): { api: RpcStub<PublicApi>; disposed: () => number } {
  let disposals = 0;

  const authenticated = Object.assign(Promise.reject(rejection), {
    whoami: () => Promise.reject(rejection),
    [Symbol.dispose]: () => { disposals++; },
  });
  // The hook attaches its own handler; this only silences Node's unhandled-rejection warning.
  authenticated.catch(() => {});

  return {
    api: { authenticate: () => authenticated } as unknown as RpcStub<PublicApi>,
    disposed: () => disposals,
  };
}

let latest: ReturnType<typeof useAuth> | null = null;

function Probe({ api }: { api: RpcStub<PublicApi> }) {
  latest = useAuth(api);
  return null;
}

let root: Root | null = null;

async function mountWithStoredToken(api: RpcStub<PublicApi>): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<Probe api={api} />);
  });
  // Let the rejection the hook is watching settle.
  await act(async () => { await Promise.resolve(); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  latest = null;
  localStorage.clear();
});

describe("useAuth with a stored token the server rejects", () => {
  it("ends the session so the app falls back to the login page", async () => {
    localStorage.setItem("authToken", "stale@example.com:secret");
    const { api } = fakePublicApi(createAuthError(AUTH_ERROR_CODES.invalidSessionToken));

    await mountWithStoredToken(api);

    expect(latest!.isAuthenticated).toBe(false);
    expect(latest!.authenticatedApi).toBeNull();
    // The token must go too, or the next reload authenticates with it all over again.
    expect(localStorage.getItem("authToken")).toBeNull();
  });

  it("releases the rejected capability rather than leaking it", async () => {
    localStorage.setItem("authToken", "stale@example.com:secret");
    const { api, disposed } = fakePublicApi(createAuthError(AUTH_ERROR_CODES.invalidSessionToken));

    await mountWithStoredToken(api);

    expect(disposed()).toBeGreaterThan(0);
  });

  // Signing someone out because their WiFi dropped would be its own bug: the connection manager
  // owns reconnection, and it re-authenticates with the same token once the socket is back.
  it("keeps the session when the failure is a lost connection", async () => {
    localStorage.setItem("authToken", "live@example.com:secret");
    const { api } = fakePublicApi(new Error("Peer closed WebSocket"));

    await mountWithStoredToken(api);

    expect(latest!.isAuthenticated).toBe(true);
    expect(localStorage.getItem("authToken")).toBe("live@example.com:secret");
  });
});

// Cloudflare Access sessions are deliberately exempt: they carry no local token to forget, and the
// root shows an "Authenticating…" spinner rather than a login page when unauthenticated, so
// clearing one would strand the user there instead of offering a way back in.
describe("useAuth in Cloudflare Access mode", () => {
  it("leaves the session alone when a call is refused", async () => {
    vi.stubEnv("VITE_CF_ACCESS_MODE", "true");
    vi.resetModules();
    const { useAuth: useAuthInAccessMode } = await import("./useAuth");

    const rejection = createAuthError(AUTH_ERROR_CODES.notAuthenticatedWithAccess);
    const authenticated = Object.assign(Promise.reject(rejection), {
      whoami: () => Promise.reject(rejection),
      [Symbol.dispose]: () => {},
    });
    authenticated.catch(() => {});
    const api = { authenticateFromCfAccess: () => authenticated } as unknown as RpcStub<PublicApi>;

    let accessLatest: ReturnType<typeof useAuth> | null = null;
    function AccessProbe() {
      accessLatest = useAuthInAccessMode(api);
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<AccessProbe />);
    });
    await act(async () => { await Promise.resolve(); });

    expect(accessLatest!.isAuthenticated).toBe(true);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
