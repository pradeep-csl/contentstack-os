// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import SandboxedGatekeeperApp from "./SandboxedGatekeeperApp";

vi.mock("./ThemeContext", () => ({
  useTheme: () => ({ resolvedThemeMode: "light" }),
}));

vi.mock("./ServerConfigContext", () => ({
  useServerConfig: () => ({ accentColor: "#7c3aed" }),
}));

vi.mock("./errorReporting", () => ({
  forwardTrustedFrameError: () => false,
}));

const WORKSPACE_ID = "a".repeat(64);

const listGadgets = vi.fn<
  () => Promise<{ id: string; title: string; owner?: { name: string } }[]>
>(async () => [
  { id: WORKSPACE_ID, title: "Daily Brief" },
]);
const authenticatedApi = { listGadgets };

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface TestHost extends RpcTarget {
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
  pickWorkspace(): Promise<{ id: string; title: string } | null>;
}

class EmptyUi extends RpcTarget {}

class TestThemeReceiver extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(_theme: GatekeeperAppTheme): void {}
}

describe("SandboxedGatekeeperApp navigation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let host: RpcStub<TestHost> | undefined;

  beforeEach(() => {
    listGadgets.mockClear();
  });

  afterEach(async () => {
    host?.[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it("provides the deployment theme and routes bounded iframe requests", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Scheduler</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({
      component: () => <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="scheduler" />,
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const gadgetRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspace/$id",
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      history,
      routeTree: rootRoute.addChildren([indexRoute, gadgetRoute]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("Missing gatekeeper iframe");
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "handshake" },
        origin: "null",
        source: iframe.contentWindow,
        ports: [port2],
      }),
    );

    const themeReceiver = new TestThemeReceiver();
    await expect(host.subscribeTheme(themeReceiver)).resolves.toEqual({
      mode: "light",
      accentColor: "#7c3aed",
    });

    await act(async () => {
      await host!.openWorkspace(WORKSPACE_ID, 2);
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`),
      );
    });
    expect(router.state.location.search).toEqual({ w: 2 });

    // Live titles come from the user's own gadget list, never from the app's snapshot. Concurrent
    // and repeated frame requests share a bounded-lifetime host-side index.
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    listGadgets
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Daily Brief" }])
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Renamed Brief" }]);
    await expect(
      Promise.all([
        host.resolveWorkspaceTitles([WORKSPACE_ID, "b".repeat(64)]),
        host.resolveWorkspaceTitles([WORKSPACE_ID]),
      ]),
    ).resolves.toEqual([["Daily Brief", null], ["Daily Brief"]]);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Daily Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(1);

    now.mockReturnValue(30_000);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Renamed Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(2);

    await expect(host.openWorkspace("../evil")).rejects.toThrow(
      "Invalid gatekeeper app workspace target",
    );
    expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`);

    await act(async () => {
      await host!.openPrompt("  Create a daily brief.  ");
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });
    expect(router.state.location.search).toEqual({ prompt: "Create a daily brief." });

    // The picker lists only workspaces the viewer owns: `owner` is set exactly when they are a
    // collaborator instead. It renders as host chrome in the Workshop document, not in the frame.
    // Opened past the shared listing's TTL, so this is a fresh listing to filter.
    now.mockReturnValue(60_000);
    const OTHERS_WORKSPACE_ID = "c".repeat(64);
    listGadgets.mockResolvedValueOnce([
      { id: WORKSPACE_ID, title: "Daily Brief" },
      { id: OTHERS_WORKSPACE_ID, title: "Someone Else's", owner: { name: "Ada" } },
    ]);

    const picked = host.pickWorkspace();
    await act(async () => { await Promise.resolve(); });
    const options = [...document.querySelectorAll('[data-testid="workspace-option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["Daily Brief"]);

    await act(async () => { (options[0] as HTMLElement).click(); });
    await expect(picked).resolves.toEqual({ id: WORKSPACE_ID, title: "Daily Brief" });
    expect(listGadgets).toHaveBeenCalledTimes(3);

    // Dismissing resolves null rather than hanging or throwing. Reopening within the TTL reuses the
    // listing the pick above fetched: the frame decides how often the picker opens.
    const dismissed = host.pickWorkspace();
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      (document.querySelector('[data-testid="workspace-picker-cancel"]') as HTMLElement).click();
    });
    await expect(dismissed).resolves.toBeNull();
    expect(listGadgets).toHaveBeenCalledTimes(3);

    // A second pick started before the first resolves supersedes it: the first resolves to null
    // (as if dismissed) instead of hanging forever with no host left to answer it.
    const firstPick = host.pickWorkspace();
    await act(async () => { await Promise.resolve(); });

    const secondPick = host.pickWorkspace();
    await act(async () => { await Promise.resolve(); });

    await expect(firstPick).resolves.toBeNull();

    const supersedingOptions = [...document.querySelectorAll('[data-testid="workspace-option"]')];
    expect(supersedingOptions.map((option) => option.textContent)).toEqual(["Daily Brief"]);
    await act(async () => { (supersedingOptions[0] as HTMLElement).click(); });
    await expect(secondPick).resolves.toEqual({ id: WORKSPACE_ID, title: "Daily Brief" });

    // A listing that fails is not an empty one. Saying "you don't own any workspaces yet" to
    // someone who owns several would send them off to create another.
    now.mockReturnValue(120_000);
    listGadgets.mockRejectedValueOnce(new Error("offline"));
    const failedPick = host.pickWorkspace();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="workspace-picker-error"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="workspace-option"]')).toHaveLength(0);
    await act(async () => {
      (document.querySelector('[data-testid="workspace-picker-cancel"]') as HTMLElement).click();
    });
    await expect(failedPick).resolves.toBeNull();
  });
});
