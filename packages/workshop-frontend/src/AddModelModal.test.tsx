// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { RpcStub } from 'capnweb'
import { ToastProvider } from '@cloudflare/kumo'
import type { AiGatewayInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import AddModelModal from './AddModelModal'

// The searchable picker (the whole point of the Select -> Combobox swap in AddModelModal.tsx) had
// zero automated coverage. This exercises the real Kumo Combobox rather than a stand-in -- a
// stand-in would hide exactly the regression this guards against: markup that compiles and
// renders every option, but never actually filters.
//
// Kumo's Dialog/Combobox render into a portal on `document.body`, not into the container we mount
// into, so assertions below query `document.body` rather than the mounted container.

const GATEWAY_CONFIG: AiGatewayInfo = {
  enabled: true,
  enabledProviders: ['anthropic', 'openrouter'],
  gateways: [
    { id: 'cloudflare', label: 'Cloudflare AI Gateway' },
    { id: 'openrouter', label: 'OpenRouter' },
  ],
}

const fakeAuthenticatedApi = {} as RpcStub<AuthenticatedApi>

function comboboxInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')
  if (!input) throw new Error('No combobox input found')
  return input
}

function listbox(): HTMLElement {
  const box = document.querySelector<HTMLElement>('[role="listbox"]')
  if (!box) throw new Error('No open listbox found')
  return box
}

async function type(query: string) {
  const input = comboboxInput()
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

describe('AddModelModal search', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  async function renderAndOpen() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ToastProvider>
          <AddModelModal
            visible
            onCancel={() => {}}
            onSuccess={() => {}}
            authenticatedApi={fakeAuthenticatedApi}
            aiConfig={GATEWAY_CONFIG}
          />
        </ToastProvider>,
      )
      await Promise.resolve()
    })

    // Open the popup: Base UI's Combobox opens on pointer-down/click on its input, same as a user
    // clicking into the field.
    const input = comboboxInput()
    await act(async () => {
      input.focus()
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
  }

  it('lists both provider groups before any query is typed', async () => {
    await renderAndOpen()

    const box = listbox()
    expect(box.textContent).toContain('Anthropic')
    expect(box.textContent).toContain('Other Anthropic...')
    expect(box.textContent).toContain('OpenRouter')
    expect(box.textContent).toContain('Other OpenRouter...')
  })

  it('narrows to the matching option and drops the non-matching group entirely', async () => {
    await renderAndOpen()

    await type('openrouter')

    const box = listbox()
    expect(box.textContent).toContain('Other OpenRouter...')
    expect(box.querySelectorAll('[role="option"]')).toHaveLength(1)
    // The non-matching provider's option, and its group (including the group label), are gone --
    // not just visually hidden.
    expect(box.textContent).not.toContain('Other Anthropic...')
    expect(box.textContent).not.toContain('Anthropic')
    expect(box.querySelectorAll('[role="group"]')).toHaveLength(1)
  })

  it('shows the empty state when the query matches nothing', async () => {
    await renderAndOpen()

    await type('zzz-no-such-provider')

    const box = listbox()
    expect(box.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(document.body.textContent).toContain('No models match your search')
  })
})
