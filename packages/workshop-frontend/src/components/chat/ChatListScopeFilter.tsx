import { DropdownMenu } from '@cloudflare/kumo'
import { CaretDown, Check } from '@phosphor-icons/react'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../menuStyles'

/** Which conversations the chat list shows: everything, or only one kind of starter. */
export type ChatListScope = 'direct' | 'agents' | 'all'

/** Human labels for {@link ChatListScope}, used by the filter's trigger and its menu. */
export const CHAT_LIST_SCOPE_LABELS: Record<ChatListScope, string> = {
  all: 'All',
  direct: 'Started by people',
  agents: 'Started by agents',
}

/** One selectable scope, with how many conversations currently fall under it. */
export type ChatListScopeOption = { value: ChatListScope; count: number }

type ChatListScopeFilterProps = {
  /** The scope currently applied to the list. */
  scope: ChatListScope
  /** Every offered scope with its live count. Empty while the list is still loading. */
  scopes: readonly ChatListScopeOption[]
  onScopeChange: (scope: ChatListScope) => void
}

/**
 * The chat list's scope switcher. It lives in the workspace top bar rather than a row of its own:
 * a single dropdown did not earn 48px of chrome, and keeping the bar one height in both the list
 * and a chat means it doesn't jump as you navigate between them.
 */
export default function ChatListScopeFilter({
  scope,
  scopes,
  onScopeChange,
}: ChatListScopeFilterProps) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left transition-colors duration-150 ease-out hover:bg-kumo-tint/60 focus-visible:bg-kumo-tint/60 focus-visible:outline-none data-[popup-open]:bg-kumo-tint/60"
            aria-label="Filter conversations"
          >
            <span className="text-ui-md font-medium text-kumo-default">
              {CHAT_LIST_SCOPE_LABELS[scope]}
            </span>
            <CaretDown
              size={10}
              weight="bold"
              className="text-kumo-subtle transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
            />
          </button>
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        {scopes.map(option => (
          <DropdownMenu.Item
            key={option.value}
            onClick={() => onScopeChange(option.value)}
            className={MENU_ITEM}
          >
            <span className="mr-2 inline-flex h-3 w-3 items-center justify-center text-kumo-default">
              {scope === option.value ? <Check size={11} weight="bold" /> : null}
            </span>
            <span className="flex-1">{CHAT_LIST_SCOPE_LABELS[option.value]}</span>
            <span className="ml-3 font-mono text-ui-2xs text-kumo-subtle">{option.count}</span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
