// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@cloudflare/kumo'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import CreateWorkspaceDialog from './components/CreateWorkspaceDialog'

// Kumo's Dialog renders into a portal on document.body, not into the mount container, so every
// query below goes through document.body.
function nameInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('input:not([type]), input[type="text"]')
  if (!input) throw new Error('No name input found')
  return input
}

function buttonLabelled(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`No button labelled ${label}`)
  return match as HTMLButtonElement
}

describe('CreateWorkspaceDialog', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  async function render(props: Partial<Parameters<typeof CreateWorkspaceDialog>[0]> = {}) {
    const onConfirm = props.onConfirm ?? vi.fn<(title: string) => void>()
    const onOpenChange = props.onOpenChange ?? vi.fn<(open: boolean) => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ToastProvider>
          <CreateWorkspaceDialog
            open
            onConfirm={onConfirm}
            onOpenChange={onOpenChange}
            {...props}
          />
        </ToastProvider>,
      )
    })
    return { onConfirm, onOpenChange }
  }

  async function type(value: string) {
    const input = nameInput()
    // Setting `input.value` directly goes through React's patched setter, which updates its
    // internal value tracker too -- so the subsequent 'input' event looks like a no-op change and
    // onChange never fires. Going through the prototype's native setter bypasses that tracker, the
    // same trick AddModelModal.test.tsx uses for its combobox input.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  it('passes the trimmed name to onConfirm', async () => {
    const { onConfirm } = await render()
    await type('  GTM Q3  ')
    await act(async () => buttonLabelled('Create').click())

    expect(onConfirm).toHaveBeenCalledWith('GTM Q3')
  })

  it('allows creating without a name, passing an empty string', async () => {
    const { onConfirm } = await render()
    await act(async () => buttonLabelled('Create').click())

    expect(onConfirm).toHaveBeenCalledWith('')
  })

  it('submits on Enter in the name field', async () => {
    const { onConfirm } = await render()
    await type('GTM Q3')
    await act(async () => {
      nameInput().closest('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(onConfirm).toHaveBeenCalledWith('GTM Q3')
  })

  it('shows progress and refuses a second submit while creating', async () => {
    const { onConfirm } = await render({ isCreating: true })

    expect(buttonLabelled('Creating...').disabled).toBe(true)
    await act(async () => buttonLabelled('Creating...').click())
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
