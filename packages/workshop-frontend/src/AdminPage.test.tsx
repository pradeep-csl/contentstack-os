// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminSettingsView, AuthenticatedApi, PublicApi, ServerConfig } from '@gadgets/workshop-shared/api'
import { RpcContext } from './RpcContext'

// AdminPage reads everything through useAuthenticatedApi() (not props), so the fake admin
// capability is threaded in via a mocked ./AuthContext rather than a component prop -- unlike the
// brief's original sketch, which assumed a prop-driven component.
const testState = vi.hoisted(() => ({
  authenticatedApi: null as unknown,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    isAdmin: true,
  }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no ResizeObserver; Kumo's Tabs (used for the General/Gatekeepers/Formats/Access tabs)
// uses one to measure the underline indicator, which is irrelevant to this test's assertions.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver ??= ResizeObserverStub

import AdminPage from './AdminPage'

function baseSettings(paused: boolean): AdminSettingsView {
  return {
    signupsEnabled: true,
    siteName: '',
    instanceInstructions: '',
    announcement: '',
    banner: { text: '', color: 'neutral' },
    accentColor: '',
    resourceVendors: [],
    formats: [],
    paused,
  }
}

function fakeAdminApi(
  options: { paused: boolean; setPaused?: Mock<(paused: boolean) => Promise<void>> },
): RpcStub<AdminApi> {
  return {
    getSettings: vi.fn<() => Promise<AdminSettingsView>>(async () => baseSettings(options.paused)),
    setPaused: options.setPaused ?? vi.fn<(paused: boolean) => Promise<void>>(async () => {}),
  } as unknown as RpcStub<AdminApi>
}

function fakeAuthenticatedApi(adminApi: RpcStub<AdminApi>): RpcStub<AuthenticatedApi> {
  return {
    getAdminApi: vi.fn<() => Promise<RpcStub<AdminApi>>>(async () => adminApi),
  } as unknown as RpcStub<AuthenticatedApi>
}

// Every enforcement path (and getServerConfig(), which this polls) reads the KV mirror, not the
// AdminSettings DO -- so unless a test cares about the lag, the default converges on the very
// first poll.
function fakeGetServerConfig(paused: boolean): Mock<() => Promise<ServerConfig>> {
  return vi.fn<() => Promise<ServerConfig>>(async () => ({ paused }) as ServerConfig)
}

function pageText(container: HTMLDivElement): string {
  return container.textContent ?? ''
}

// Excludes dialog content: once the confirm dialog is open, its confirm button carries the same
// label as the trigger that opened it.
function pageButton(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label && !b.closest('[role="dialog"]'))
  if (!match) throw new Error(`No page button labelled "${label}"`)
  return match as HTMLButtonElement
}

function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.body.querySelector('[role="dialog"]')
  if (!dialog) throw new Error('No open dialog')
  const match = [...dialog.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`No dialog button labelled "${label}"`)
  return match as HTMLButtonElement
}

describe('AdminPage deployment pause control', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    vi.useRealTimers()
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  async function mount(adminApi: RpcStub<AdminApi>, getServerConfig?: Mock<() => Promise<ServerConfig>>) {
    testState.authenticatedApi = fakeAuthenticatedApi(adminApi)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const stub = { getServerConfig: getServerConfig ?? fakeGetServerConfig(false) } as unknown as RpcStub<PublicApi>
    await act(async () => {
      root!.render(
        <RpcContext.Provider value={{ stub, connectionLost: false }}>
          <AdminPage />
        </RpcContext.Provider>,
      )
      // Let the two chained loads (getAdminApi() then getSettings()) resolve.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('calls setPaused when the admin pauses the deployment', async () => {
    const setPaused = vi.fn<(paused: boolean) => Promise<void>>(async () => {})
    // Converges immediately: the mirror already agrees by the time the poll checks it.
    await mount(fakeAdminApi({ paused: false, setPaused }), fakeGetServerConfig(true))

    await act(async () => { pageButton('Pause deployment').click() })
    await act(async () => {
      dialogButton('Pause deployment').click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(setPaused).toHaveBeenCalledWith(true)
  })

  it('offers resume when already paused', async () => {
    await mount(fakeAdminApi({ paused: true }))
    expect(pageButton('Resume deployment')).toBeTruthy()
  })

  // Finding 0: getSettings() reads the AdminSettings DO's own (immediately-updated) copy, but
  // every enforcement path reads the KV mirror, which getServerConfig() is built from and which can
  // lag ~60s. Claiming "paused" off the DO would tell the admin spend had stopped when it had not,
  // so the UI must poll getServerConfig() and only report success once it agrees.
  it('shows applying until the server config mirror agrees', async () => {
    const getServerConfig = vi.fn<() => Promise<ServerConfig>>()
      .mockResolvedValueOnce({ paused: false } as ServerConfig)
      .mockResolvedValueOnce({ paused: true } as ServerConfig)
    const setPaused = vi.fn<(paused: boolean) => Promise<void>>(async () => {})

    vi.useFakeTimers()
    await mount(fakeAdminApi({ paused: false, setPaused }), getServerConfig)

    await act(async () => { pageButton('Pause deployment').click() })
    await act(async () => { dialogButton('Pause deployment').click() })

    // setPaused()'s optimistic "applying" state is visible immediately, before the mirror has been
    // checked even once -- it must never be skipped in favor of jumping straight to "paused".
    expect(pageText(container!)).toMatch(/applying/i)
    expect(pageText(container!)).not.toMatch(/this deployment is paused/i)

    // Runs the first (stale) poll, the 5s wait, and the second (converged) poll.
    await act(async () => { await vi.runAllTimersAsync() })

    expect(setPaused).toHaveBeenCalledWith(true)
    expect(getServerConfig).toHaveBeenCalledTimes(2)
    expect(pageText(container!)).toMatch(/this deployment is paused/i)
    expect(pageText(container!)).not.toMatch(/applying/i)
  })

  it('reports a timeout without ever claiming the pause is confirmed', async () => {
    // The mirror never agrees within the poll window -- e.g. a KV write that never lands.
    const getServerConfig = vi.fn<() => Promise<ServerConfig>>(async () => ({ paused: false }) as ServerConfig)
    const setPaused = vi.fn<(paused: boolean) => Promise<void>>(async () => {})

    vi.useFakeTimers()
    await mount(fakeAdminApi({ paused: false, setPaused }), getServerConfig)

    await act(async () => { pageButton('Pause deployment').click() })
    await act(async () => { dialogButton('Pause deployment').click() })

    // Advance past the 90s give-up point with a margin, so the final deadline check (which runs
    // after the last 5s wait, not exactly at t=90s once scheduling epsilons are included) is
    // guaranteed to fire within this advance.
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000) })

    expect(pageText(container!)).toMatch(/still applying/i)
    expect(pageText(container!)).toMatch(/reload to check/i)
    // Never presents the DO's (unverified) value as confirmed.
    expect(pageText(container!)).not.toMatch(/this deployment is paused/i)
    expect(pageButton('Pause deployment')).toBeTruthy()
  })
})
