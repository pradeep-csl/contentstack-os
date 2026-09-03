// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkspaceBreadcrumb from './WorkspaceBreadcrumb'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(ui: React.ReactElement): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(ui) })
  return container
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    // React tracks the last value it wrote on the DOM node; overwrite it so the synthetic
    // change event isn't swallowed as a no-op.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressKey(element: Element, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

describe('WorkspaceBreadcrumb', () => {
  const base = {
    workspaceTitle: 'Marketing Site',
    onOpenChatList: () => {},
    onRenameWorkspace: () => {},
  }

  describe('with a chat open', () => {
    it('shows both crumbs, marking the chat as the current page', () => {
      const dom = render(<WorkspaceBreadcrumb {...base} chatTitle="Greeting and Conversation Start" />)

      expect(dom.textContent).toContain('Marketing Site')
      expect(dom.querySelector('[aria-current="page"]')?.textContent)
        .toBe('Greeting and Conversation Start')
    })

    it('returns to the chat list when the workspace crumb is clicked', () => {
      const onOpenChatList = vi.fn<() => void>()
      const dom = render(
        <WorkspaceBreadcrumb {...base} onOpenChatList={onOpenChatList} chatTitle="Some chat" />
      )

      click(dom.querySelector('[aria-label="Back to conversations"]')!)

      expect(onOpenChatList).toHaveBeenCalledTimes(1)
    })

    // Renaming the workspace belongs to the chat list, where the workspace is the thing being
    // managed. Inside a chat the header is navigation only.
    it('offers no workspace rename', () => {
      const dom = render(<WorkspaceBreadcrumb {...base} chatTitle="Some chat" />)

      expect(dom.querySelector('[aria-label="Rename workspace"]')).toBeNull()
    })
  })

  describe('on the chat list', () => {
    it('shows the workspace alone, with no chat crumb', () => {
      const dom = render(<WorkspaceBreadcrumb {...base} chatTitle={null} />)

      expect(dom.textContent).toContain('Marketing Site')
      expect(dom.querySelector('[aria-current="page"]')?.textContent).toBe('Marketing Site')
      expect(dom.querySelector('[aria-label="Back to conversations"]')).toBeNull()
    })

    it('commits a renamed workspace on Enter', () => {
      const onRenameWorkspace = vi.fn<(title: string) => void>()
      const dom = render(
        <WorkspaceBreadcrumb {...base} chatTitle={null} onRenameWorkspace={onRenameWorkspace} />
      )

      click(dom.querySelector('[aria-label="Rename workspace"]')!)
      const input = dom.querySelector('input') as HTMLInputElement
      type(input, '  Brand Refresh  ')
      pressKey(input, 'Enter')

      expect(onRenameWorkspace).toHaveBeenCalledWith('Brand Refresh')
      expect(dom.querySelector('input')).toBeNull()
    })

    it('discards the edit on Escape', () => {
      const onRenameWorkspace = vi.fn<(title: string) => void>()
      const dom = render(
        <WorkspaceBreadcrumb {...base} chatTitle={null} onRenameWorkspace={onRenameWorkspace} />
      )

      click(dom.querySelector('[aria-label="Rename workspace"]')!)
      type(dom.querySelector('input') as HTMLInputElement, 'Abandoned')
      pressKey(dom.querySelector('input')!, 'Escape')

      expect(onRenameWorkspace).not.toHaveBeenCalled()
      expect(dom.querySelector('input')).toBeNull()
      expect(dom.textContent).toContain('Marketing Site')
    })

    it('refuses to commit a blank title', () => {
      const onRenameWorkspace = vi.fn<(title: string) => void>()
      const dom = render(
        <WorkspaceBreadcrumb {...base} chatTitle={null} onRenameWorkspace={onRenameWorkspace} />
      )

      click(dom.querySelector('[aria-label="Rename workspace"]')!)
      const input = dom.querySelector('input') as HTMLInputElement
      type(input, '   ')
      pressKey(input, 'Enter')

      expect(onRenameWorkspace).not.toHaveBeenCalled()
      expect(dom.querySelector('input')).not.toBeNull()
    })

    // The draft is seeded when editing opens, so a title that changed while the editor was closed
    // (a rename from another tab, or the agent naming a fresh workspace) is what gets edited.
    it('seeds the draft from the current title each time editing opens', () => {
      const dom = render(<WorkspaceBreadcrumb {...base} chatTitle={null} />)

      click(dom.querySelector('[aria-label="Rename workspace"]')!)
      type(dom.querySelector('input') as HTMLInputElement, 'Scratch')
      pressKey(dom.querySelector('input')!, 'Escape')

      act(() => {
        root!.render(
          <WorkspaceBreadcrumb {...base} workspaceTitle="Renamed Elsewhere" chatTitle={null} />
        )
      })
      click(dom.querySelector('[aria-label="Rename workspace"]')!)

      expect((dom.querySelector('input') as HTMLInputElement).value).toBe('Renamed Elsewhere')
    })
  })
})
