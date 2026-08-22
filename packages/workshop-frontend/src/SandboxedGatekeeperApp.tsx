import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { useNavigate } from '@tanstack/react-router'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from '@gadgets/workshop-shared/theme'
import { isHexColor, type GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { createRateLimitedCapability } from './rateLimitedCapability'
import { useTheme } from './ThemeContext'
import { useServerConfig } from './ServerConfigContext'
import { forwardTrustedFrameError } from './errorReporting'
import { useAuthenticatedApi } from './AuthContext'
import GatekeeperWorkspacePicker, { type PickableWorkspace } from './GatekeeperWorkspacePicker'
import {
  normalizeGatekeeperAppPrompt,
  parseGatekeeperAppWorkspaceTarget,
  type GatekeeperAppWorkspaceTarget,
} from './gatekeeperAppNavigation'

// The content-pane rect, in viewport coordinates, that the app pins its page to while the iframe
// is full-viewport.
type OverlayRect = { left: number; top: number; width: number; height: number }

// The host's reply to a present/dismiss. On open, `rect` is where the app holds its page fixed while
// the iframe expands to full-viewport (null on restore); `willResize` is whether switching the iframe
// to/from full-viewport actually changes its pixel size (it won't if the pane already fills the window).
type PresentAck = { rect: OverlayRect | null; willResize: boolean }

// Grows the app's iframe to a full-viewport overlay for app-level modals (true) or restores it (false).
type PresentController = (active: boolean) => PresentAck
type OpenTarget = (target: GatekeeperAppWorkspaceTarget) => void
// Resolves workspace IDs the app already holds to their live titles; null for a workspace the user
// can no longer see. Deliberately a lookup, not an enumeration: the app learns nothing new.
type ResolveWorkspaceTitles = (ids: string[]) => Promise<(string | null)[]>
// Presents the Workshop's own picker and resolves to the single workspace the user chose (null if
// dismissed). Deliberately a pick, not an enumeration: the app learns one workspace, never the list.
type PickWorkspace = () => Promise<PickableWorkspace | null>
type OpenPrompt = (prompt: string) => void

type OverlayState = 'full' | null

// Upper bound on one workspace-title lookup, matching the app's page size.
const MAX_RESOLVED_WORKSPACES = 100

// How long one gadget listing is reused across both workspace capabilities. The untrusted frame
// looks titles up once per page of rows and can reopen the picker as often as it likes (either in a
// loop), so the two share one bounded-lifetime listing rather than each repeating it.
const WORKSPACE_LISTING_TTL_MS = 10_000

// Near the max int, so the full-viewport iframe sits above all Workshop chrome.
const overlayZIndex = 2147483000

const baseIframeStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
}

function iframeStyleForOverlay(overlay: OverlayState): CSSProperties {
  if (overlay === 'full') {
    return {
      ...baseIframeStyle,
      position: 'fixed',
      inset: 0,
      width: '100vw',
      height: '100vh',
      zIndex: overlayZIndex,
    }
  }
  return {
    ...baseIframeStyle,
    display: 'block',
    width: '100%',
    height: '100%',
  }
}

// The host capability exposed to the sandboxed app (the gatekeeper's iframe UI) over the MessagePort
// RPC session. The app uses `ui` to reach the gatekeeper's own capability, which Workshop relays and
// rate-limits. `setPresenting` stays in Workshop and only grows/restores the iframe's layout.
class GatekeeperAppHostImpl extends RpcTarget {
  readonly #ui: RpcStub<RpcTarget>
  readonly #disposeRateLimiter: () => void
  readonly #present: PresentController
  readonly #openTarget: OpenTarget
  readonly #openPrompt: OpenPrompt
  readonly #resolveWorkspaceTitles: ResolveWorkspaceTitles
  readonly #pickWorkspace: PickWorkspace
  #presenting = false
  #theme: GatekeeperAppTheme
  #themeReceiver: RpcStub<GatekeeperAppThemeReceiver> | null = null
  // Presentation changes are coalesced to a single apply per animation frame (see #applyPending).
  #pendingActive: boolean | null = null
  #pendingResolvers: ((ack: PresentAck) => void)[] = []
  #frameId: number | null = null

  constructor(
    capability: any,
    present: PresentController,
    theme: GatekeeperAppTheme,
    openTarget: OpenTarget,
    openPrompt: OpenPrompt,
    resolveWorkspaceTitles: ResolveWorkspaceTitles,
    pickWorkspace: PickWorkspace,
  ) {
    super()
    this.#theme = theme
    const { capability: ui, dispose } = createRateLimitedCapability(capability, {
      maxConcurrency: 8,
      maxCallsPerMinute: 600,
      maxPendingCalls: 128,
      onRateLimit: 'throttle',
      label: 'Gatekeeper app',
    })
    this.#ui = ui
    this.#disposeRateLimiter = dispose
    this.#present = present
    this.#openTarget = openTarget
    this.#openPrompt = openPrompt
    this.#resolveWorkspaceTitles = resolveWorkspaceTitles
    this.#pickWorkspace = pickWorkspace
  }

  get ui(): RpcStub<RpcTarget> {
    return this.#ui
  }

  // Navigate to a workspace the app knows about. The IDs are validated here because the app is
  // untrusted; navigation stays in-app rather than handing the frame a URL to follow.
  openWorkspace(workspaceId: string, gadgetId?: number): void {
    this.#openTarget(parseGatekeeperAppWorkspaceTarget(workspaceId, gadgetId))
  }

  // Resolve live titles for workspaces the app already references, so it never renders a stale
  // snapshot. Bounded per call; unknown or no-longer-visible workspaces come back as null.
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]> {
    if (!Array.isArray(ids) || ids.length > MAX_RESOLVED_WORKSPACES) {
      throw new TypeError('Invalid workspace title lookup.')
    }
    return this.#resolveWorkspaceTitles(ids)
  }

  // The app calls this to let the user choose one workspace. Only the pick crosses back.
  pickWorkspace(): Promise<PickableWorkspace | null> {
    return this.#pickWorkspace()
  }

  openPrompt(prompt: string): void {
    this.#openPrompt(normalizeGatekeeperAppPrompt(prompt))
  }

  // The app calls this once to learn the current theme and register a receiver for later changes.
  // Apps that don't theme themselves never call it.
  subscribeTheme(receiver: RpcStub<GatekeeperAppThemeReceiver>): GatekeeperAppTheme {
    this.#themeReceiver?.[Symbol.dispose]?.()
    // The argument stub is disposed when this call returns, so keep our own dup (released in dispose).
    this.#themeReceiver = receiver.dup()
    return this.#theme
  }

  #dropThemeReceiver(receiver: RpcStub<GatekeeperAppThemeReceiver>) {
    if (this.#themeReceiver !== receiver) return
    receiver[Symbol.dispose]?.()
    this.#themeReceiver = null
  }

  // Push a new theme to a subscribed app; a no-op until (and unless) the app subscribes.
  updateTheme(theme: GatekeeperAppTheme) {
    this.#theme = theme
    const receiver = this.#themeReceiver
    if (!receiver) return

    try {
      Promise.resolve(receiver.setTheme(theme)).catch(() => this.#dropThemeReceiver(receiver))
    } catch {
      this.#dropThemeReceiver(receiver)
    }
  }

  // Queue a presentation change; the latest requested state is applied on the next frame.
  setPresenting(active: boolean): Promise<PresentAck> {
    return new Promise((resolve) => {
      this.#pendingActive = active
      this.#pendingResolvers.push(resolve)
      this.#frameId ??= requestAnimationFrame(() => this.#applyPending())
    })
  }

  // Apply the last-requested state once, resolving every caller queued this frame with the result.
  #applyPending() {
    this.#frameId = null
    const active = this.#pendingActive!
    const resolvers = this.#pendingResolvers
    this.#pendingActive = null
    this.#pendingResolvers = []
    // No-op toggles skip the layout apply.
    const ack: PresentAck =
      active === this.#presenting ? { rect: null, willResize: false } : this.#present(active)
    this.#presenting = active
    for (const resolve of resolvers) resolve(ack)
  }

  // Cancel the rate limiter's pending resume timer once this host is no longer in use.
  dispose() {
    this.#disposeRateLimiter()
    this.#themeReceiver?.[Symbol.dispose]?.()
    this.#themeReceiver = null
    if (this.#frameId !== null) {
      cancelAnimationFrame(this.#frameId)
      this.#frameId = null
    }
    for (const resolve of this.#pendingResolvers) resolve({ rect: null, willResize: false })
    this.#pendingResolvers = []
    this.#pendingActive = null
    if (this.#presenting) {
      this.#presenting = false
      this.#present(false)
    }
  }
}

/**
 * Hosts a gatekeeper's full-page management SPA in a sandboxed, network-isolated iframe. The app
 * talks to the gatekeeper only through the `ui` capability carried over the MessagePort RPC session.
 * The iframe fills its parent container.
 */
export default function SandboxedGatekeeperApp({ frame, gatekeeperVendorId }: {
  frame: GatekeeperUiFrame,
  gatekeeperVendorId: string,
}) {
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const sessionRef = useRef<{ [Symbol.dispose]?(): void } | null>(null)
  const hostRef = useRef<GatekeeperAppHostImpl | null>(null)
  const connectedRef = useRef(false)
  const invalidatedRef = useRef(false)
  const [overlay, setOverlay] = useState<OverlayState>(null)
  const overlayRef = useRef<OverlayState>(null)
  // Push the Workshop's resolved light/dark mode and deployment accent whenever either changes.
  const { resolvedThemeMode } = useTheme()
  const configuredAccentColor = useServerConfig()?.accentColor
  const accentColor = configuredAccentColor && isHexColor(configuredAccentColor)
    ? configuredAccentColor
    : null
  const themeRef = useRef<GatekeeperAppTheme>({ mode: resolvedThemeMode, accentColor })
  themeRef.current = { mode: resolvedThemeMode, accentColor }
  useEffect(() => {
    hostRef.current?.updateTheme({ mode: resolvedThemeMode, accentColor })
  }, [resolvedThemeMode, accentColor])

  const setOverlayPhase = useCallback((next: OverlayState) => {
    if (overlayRef.current === next) return
    overlayRef.current = next
    setOverlay(next)
  }, [])

  // Grow the iframe to full-viewport (or restore it), then report back the pane rect and whether the
  // size actually changed.
  const present = useCallback<PresentController>((active) => {
    const el = iframeRef.current
    const before = el?.getBoundingClientRect()
    // Duplicate restores are common during cleanup; avoid forcing layout when already restored.
    if (!active && overlayRef.current === null) return { rect: null, willResize: false }
    flushSync(() => setOverlayPhase(active ? 'full' : null))
    const after = el?.getBoundingClientRect()
    const willResize =
      !!before && !!after && (before.width !== after.width || before.height !== after.height)
    // On open, `before` is the pane rect the app pins to.
    const rect =
      active && before
        ? { left: before.left, top: before.top, width: before.width, height: before.height }
        : null
    return { rect, willResize }
  }, [setOverlayPhase])
  const openTarget = useCallback<OpenTarget>(({ workspaceId, gadgetId }) => {
    navigate({
      to: '/workspace/$id',
      params: { id: workspaceId },
      search: gadgetId === undefined ? {} : { w: gadgetId },
    })
  }, [navigate])
  const listingRef = useRef<
    { at: number, gadgets: Promise<GadgetMetadataWithTimestamps[]> } | null
  >(null)
  const listWorkspaces = useCallback(() => {
    let entry = listingRef.current
    if (!entry || Date.now() - entry.at >= WORKSPACE_LISTING_TTL_MS) {
      entry = { at: Date.now(), gadgets: authenticatedApi.listGadgets() }
      listingRef.current = entry
      // Don't cache a failure: drop it so the next caller retries.
      const failed = entry
      entry.gadgets.catch(() => {
        if (listingRef.current === failed) listingRef.current = null
      })
    }
    return entry.gadgets
  }, [authenticatedApi])
  const resolveWorkspaceTitles = useCallback<ResolveWorkspaceTitles>(async (ids) => {
    const gadgets = await listWorkspaces()
    const titles = new Map(gadgets.map((gadget) => [gadget.id, gadget.title]))
    return ids.map((id) => titles.get(id) ?? null)
  }, [listWorkspaces])
  // Only workspaces the user owns are offered: `owner` is set exactly when the viewer is a
  // collaborator instead. `role` is the wrong filter here — the owner is always "build", but so is
  // a build-role collaborator.
  const listOwnedWorkspaces = useCallback(async (): Promise<PickableWorkspace[]> => {
    return (await listWorkspaces())
      .filter((gadget) => !gadget.owner)
      .map((gadget) => ({ id: gadget.id, title: gadget.title }))
  }, [listWorkspaces])
  const openPrompt = useCallback<OpenPrompt>((prompt) => {
    navigate({ to: '/', search: { prompt } })
  }, [navigate])
  const [pendingPick, setPendingPick] = useState<
    ((workspace: PickableWorkspace | null) => void) | null
  >(null)
  // Mirrors `pendingPick` outside React state so a superseding pick or an unmount can resolve the
  // still-outstanding one synchronously, without waiting on a render to see it.
  const pendingPickRef = useRef<((workspace: PickableWorkspace | null) => void) | null>(null)
  const pickWorkspace = useCallback<PickWorkspace>(() => {
    return new Promise((resolve) => {
      // A pick started while another is still outstanding supersedes it: the earlier request
      // resolves to null (the same value a dismissal produces) rather than hanging forever with
      // no host left to answer it.
      pendingPickRef.current?.(null)
      const resolveOnce = (workspace: PickableWorkspace | null) => {
        pendingPickRef.current = null
        setPendingPick(null)
        resolve(workspace)
      }
      pendingPickRef.current = resolveOnce
      // Wrapped in an object: a bare function passed to a state setter would be *called*.
      setPendingPick(() => resolveOnce)
    })
  }, [])
  // A pick left pending when the component unmounts is resolved the same way, rather than
  // depending on teardown ordering elsewhere (e.g. the capnweb session aborting) to notice it.
  useEffect(() => {
    return () => pendingPickRef.current?.(null)
  }, [])
  // The gatekeeper capability is `any`: its method shape is gatekeeper-defined and opaque to us.
  const capabilityRef = useRef<any>(null)
  capabilityRef.current = frame.ui

  useEffect(() => {
    connectedRef.current = false
    invalidatedRef.current = false

    const connect = (port: MessagePort) => {
      if (connectedRef.current) {
        // A second handshake (e.g. iframe reloaded) invalidates the session.
        invalidatedRef.current = true
        port.close()
        sessionRef.current?.[Symbol.dispose]?.()
        sessionRef.current = null
        hostRef.current?.dispose()
        hostRef.current = null
        setOverlayPhase(null)
        return
      }
      if (invalidatedRef.current || !capabilityRef.current) {
        port.close()
        return
      }
      const host = new GatekeeperAppHostImpl(
        capabilityRef.current,
        present,
        themeRef.current,
        openTarget,
        openPrompt,
        resolveWorkspaceTitles,
        pickWorkspace,
      )
      hostRef.current = host
      sessionRef.current = newMessagePortRpcSession(port, host)
      connectedRef.current = true
    }

    const handleMessage = (event: MessageEvent) => {
      // Only accept the handshake from our own sandboxed iframe (which posts from a null origin).
      // Capture contentWindow first: if the frame isn't mounted there's no legitimate sender, so
      // reject — comparing against a concrete window avoids a `source === undefined` edge.
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow || event.origin !== 'null') return
      if (invalidatedRef.current) return
      if (forwardTrustedFrameError(
        event, frameWindow, { surface: 'gatekeeper-app', gatekeeperVendorId },
      )) return
      if (event.data?.type === 'handshake' && event.ports?.[0]) {
        connect(event.ports[0])
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      sessionRef.current?.[Symbol.dispose]?.()
      sessionRef.current = null
      hostRef.current?.dispose()
      hostRef.current = null
      setOverlayPhase(null)
    }
    // Re-establish the session if either the HTML or the `ui` capability changes, so a new frame
    // carrying a fresh stub (even with identical HTML) never keeps talking through the stale one.
  }, [frame.iframeHtml, frame.ui, gatekeeperVendorId, openPrompt, openTarget,
      pickWorkspace, present, resolveWorkspaceTitles, setOverlayPhase])

  return (
    <>
      <iframe
        ref={iframeRef}
        srcDoc={frame.iframeHtml}
        // allow-scripts: run the app's JS. allow-modals: its beforeunload unsaved-changes guard. Not
        // allow-same-origin (the frame stays an opaque origin), and the app's CSP keeps connect-src 'none'.
        sandbox="allow-scripts allow-modals"
        allow="clipboard-write"
        title="Gatekeeper app"
        style={iframeStyleForOverlay(overlay)}
      />
      {pendingPick ? (
        <GatekeeperWorkspacePicker listWorkspaces={listOwnedWorkspaces} onPick={pendingPick} />
      ) : null}
    </>
  )
}
