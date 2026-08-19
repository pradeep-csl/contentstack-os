// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// `authenticatedApi` must be a single stable object: SidebarWorkspacesProvider's data-loading
// effects depend on it (`[authenticatedApi]`), so a mock that rebuilds the object on every call
// would re-fire those effects every render and spin forever.
const testState = vi.hoisted(() => {
  const addToast = vi.fn<(toast: unknown) => void>()
  const createWorkspace = vi.fn<(title: string) => unknown>()
  const listGadgets = vi.fn<() => Promise<never[]>>(async () => [])
  const navigate = vi.fn<(options: unknown) => void>()
  const whoami = vi.fn<() => Promise<null>>(async () => null)
  return {
    addToast,
    createWorkspace,
    listGadgets,
    navigate,
    whoami,
    authenticatedApi: { createWorkspace, listGadgets, whoami },
  }
})

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => testState.navigate,
  Link: ({ children }: { children?: unknown }) => <span>{children as never}</span>,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('./ShareModal', () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import {
  SidebarWorkspacesProvider,
  SidebarWorkspacesLists,
  mergeServerWorkspaces,
} from './components/AppShell/SidebarWorkspaces'
import { openCreateWorkspace } from './components/AppShell/createWorkspaceBus'

function buttonLabelled(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`No button labelled ${label}`)
  return match as HTMLButtonElement
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setValue.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('create workspace from the rail-owned dialog', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  async function mount() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <SidebarWorkspacesProvider>
          <SidebarWorkspacesLists />
        </SidebarWorkspacesProvider>,
      )
    })
  }

  it('creates the workspace, shows it in the rail, and navigates into it', async () => {
    const dispose = vi.fn<() => void>()
    testState.createWorkspace.mockReturnValue({
      getMetadata: async () => ({ id: 'ws-new', title: 'GTM Q3' }),
      [Symbol.dispose]: dispose,
    })

    await mount()
    await act(async () => { openCreateWorkspace() })

    const input = document.body.querySelector<HTMLInputElement>('input:not([type]), input[type="text"]')!
    await act(async () => {
      setInputValue(input, 'GTM Q3')
    })
    await act(async () => buttonLabelled('Create').click())

    expect(testState.createWorkspace).toHaveBeenCalledWith('GTM Q3')
    expect(testState.navigate).toHaveBeenCalledWith({
      to: '/workspace/$id',
      params: { id: 'ws-new' },
    })
    // Appears in the rail without a refetch: listGadgets ran once, on mount.
    expect(testState.listGadgets).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain('GTM Q3')
    expect(dispose).toHaveBeenCalled()
  })

  it('keeps an optimistically added workspace after a stale (pre-creation) listGadgets() resolves', async () => {
    // Simulates the load effect's listGadgets() being in flight (e.g. from a reconnect-triggered
    // rerun) when a workspace is created: it resolves afterward with a list that predates the
    // creation. A naive `setGadgets(list)` would wipe out the optimistic splice; the merge in the
    // load effect must keep the locally-known workspace instead.
    let resolveList!: () => void
    testState.listGadgets.mockImplementationOnce(
      () => new Promise<never[]>((resolve) => { resolveList = () => resolve([]) }),
    )

    const dispose = vi.fn<() => void>()
    testState.createWorkspace.mockReturnValue({
      getMetadata: async () => ({ id: 'ws-new', title: 'GTM Q3' }),
      [Symbol.dispose]: dispose,
    })

    await mount()
    await act(async () => { openCreateWorkspace() })

    const input = document.body.querySelector<HTMLInputElement>('input:not([type]), input[type="text"]')!
    await act(async () => { setInputValue(input, 'GTM Q3') })
    await act(async () => buttonLabelled('Create').click())

    expect(testState.navigate).toHaveBeenCalledWith({
      to: '/workspace/$id',
      params: { id: 'ws-new' },
    })

    // The stale, pre-creation fetch resolves last -- the new workspace must survive the merge.
    await act(async () => { resolveList() })

    expect(container!.textContent).toContain('GTM Q3')
  })

  it('drops a workspace the server no longer lists, and stops protecting a confirmed one', () => {
    // The other half of the merge: carrying over *every* locally-known workspace would make the
    // server's list non-authoritative, so a workspace deleted in another tab -- or one whose share
    // was revoked -- would keep reappearing on each reconnect. Only unconfirmed ids survive.
    const ws = (id: string): GadgetMetadataWithTimestamps => ({
      id, title: id, created: new Date(0), lastActive: new Date(0),
    })

    // 'ws-gone' came from an earlier listing and the server has now dropped it: it must not survive.
    expect(
      mergeServerWorkspaces([ws('ws-kept')], [ws('ws-kept'), ws('ws-gone')], new Set()).map((g) => g.id),
    ).toEqual(['ws-kept'])

    // An unconfirmed optimistic id survives a listing that predates it...
    expect(
      mergeServerWorkspaces([], [ws('ws-new')], new Set(['ws-new'])).map((g) => g.id),
    ).toEqual(['ws-new'])

    // ...but is not duplicated once a listing does mention it.
    expect(
      mergeServerWorkspaces([ws('ws-new')], [ws('ws-new')], new Set()).map((g) => g.id),
    ).toEqual(['ws-new'])
  })

  it('reports a failure and leaves the rail unchanged', async () => {
    testState.createWorkspace.mockReturnValue({
      getMetadata: async () => { throw new Error('nope') },
      [Symbol.dispose]: vi.fn<() => void>(),
    })

    await mount()
    await act(async () => { openCreateWorkspace() })
    await act(async () => buttonLabelled('Create').click())

    expect(testState.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to create workspace' }),
    )
    expect(testState.navigate).not.toHaveBeenCalled()
    expect(container!.textContent).not.toContain('GTM Q3')
  })
})
