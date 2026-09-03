import { useState } from 'react'
import { CaretLeft, Check, Pencil, X } from '@phosphor-icons/react'
import { WorkshopIconButton, WorkshopInput } from './WorkshopControls'

type WorkspaceBreadcrumbProps = {
  /** Title of the workspace this header belongs to. */
  workspaceTitle: string
  /** Title of the open chat, or null when the workspace's chat list is showing. */
  chatTitle: string | null
  /** Return to the workspace's chat list. Wired to the workspace crumb while a chat is open. */
  onOpenChatList: () => void
  /** Commit a new, non-blank workspace title. */
  onRenameWorkspace: (title: string) => void
}

/**
 * The workspace/chat trail in the workspace top bar, and the whole of what used to be a second
 * header row below it.
 *
 * The two states are deliberately different affordances rather than one row that grows a crumb:
 * with a chat open the workspace crumb is the way back to the chat list (it replaced a bare `‹`
 * button, and unlike that button it names where it goes), and the header is navigation only.
 * Renaming is offered on the chat list, where the workspace is the thing being managed — the same
 * split the chat list itself uses, where a chat is renamed from its row and not from inside it.
 */
export default function WorkspaceBreadcrumb({
  workspaceTitle,
  chatTitle,
  onOpenChatList,
  onRenameWorkspace,
}: WorkspaceBreadcrumbProps) {
  // `null` while not editing. Seeded on open so a title that changed underneath us — an agent
  // naming a fresh workspace, a rename in another tab — is what gets edited.
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    const trimmed = draft?.trim()
    if (!trimmed) return
    onRenameWorkspace(trimmed)
    setDraft(null)
  }

  if (draft !== null) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <WorkshopInput
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setDraft(null)
          }}
          autoFocus
          aria-label="Workspace title"
          className="!h-7 w-56 bg-kumo-tint text-ui-md font-medium"
        />
        <WorkshopIconButton
          onClick={commit}
          disabled={!draft.trim()}
          className="!h-7 !w-7 hover:text-kumo-brand disabled:opacity-30"
          aria-label="Save workspace title"
        >
          <Check size={14} />
        </WorkshopIconButton>
        <WorkshopIconButton
          onClick={() => setDraft(null)}
          className="!h-7 !w-7"
          aria-label="Cancel title edit"
        >
          <X size={14} />
        </WorkshopIconButton>
      </div>
    )
  }

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
      {chatTitle === null ? (
        <>
          <span
            aria-current="page"
            className="truncate text-ui-md font-medium text-kumo-default"
          >
            {workspaceTitle}
          </span>
          <WorkshopIconButton
            onClick={() => setDraft(workspaceTitle)}
            className="!h-7 !w-7 flex-shrink-0"
            title="Rename workspace"
            aria-label="Rename workspace"
          >
            <Pencil size={16} />
          </WorkshopIconButton>
        </>
      ) : (
        <>
          {/* Below `sm` the workspace name would eat the room the chat title needs, so it
              collapses to the caret it replaced. */}
          <button
            type="button"
            onClick={onOpenChatList}
            title="Back to conversations"
            aria-label="Back to conversations"
            className="flex flex-shrink-0 cursor-pointer items-center rounded-md text-ui-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default sm:max-w-[14rem] sm:px-1.5 sm:py-0.5"
          >
            <CaretLeft size={14} className="h-7 w-7 p-1.5 sm:hidden" />
            <span className="hidden truncate sm:inline">{workspaceTitle}</span>
          </button>
          <span aria-hidden="true" className="hidden flex-shrink-0 text-kumo-subtle sm:inline">
            /
          </span>
          <span
            aria-current="page"
            className="min-w-0 truncate text-ui-md font-medium text-kumo-default"
          >
            {chatTitle}
          </span>
        </>
      )}
    </nav>
  )
}
