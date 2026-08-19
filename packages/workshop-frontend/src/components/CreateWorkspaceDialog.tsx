import { Dialog, Input } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'

// A UI guard against a pathological paste, not a validated limit: the server mirrors setTitle's
// leniency and stores whatever it is given.
const MAX_TITLE_LENGTH = 120

interface CreateWorkspaceDialogProps {
  open: boolean
  /** True while the create RPC is in flight; blocks a second submit and swaps the button label. */
  isCreating?: boolean
  onOpenChange: (open: boolean) => void
  /** Receives the trimmed name, or '' when the user left the field blank. */
  onConfirm: (title: string) => void
}

// Names a workspace before it exists. Purely presentational -- the owner does the RPC, decides where
// to navigate, and reports failures, so this stays testable without a server.
export default function CreateWorkspaceDialog({
  open,
  isCreating = false,
  onOpenChange,
  onConfirm,
}: CreateWorkspaceDialogProps) {
  const [title, setTitle] = useState('')

  // Every opening starts from an empty field rather than the previous attempt's text.
  useEffect(() => {
    if (open) setTitle('')
  }, [open])

  const submit = () => {
    if (isCreating) return
    onConfirm(title.trim())
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isCreating) onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="!z-[1000] !w-[min(420px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[20%] !-translate-y-0"
        size="sm"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              Create workspace
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              An isolated environment for a set of conversations, connections, and outputs.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton
                {...props}
                className="!h-7 !w-7"
                disabled={isCreating}
                aria-label="Close"
              >
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        {/* A form so Enter in the field creates the workspace. */}
        <form
          className="px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Input
            label="Name"
            placeholder="e.g. GTM Q3"
            description="you can rename it any time."
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            disabled={isCreating}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </form>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
          <Dialog.Close
            render={(props) => (
              <WorkshopButton {...props} className="!h-9" disabled={isCreating}>
                Cancel
              </WorkshopButton>
            )}
          />
          <WorkshopButton
            tone="primary"
            onClick={submit}
            disabled={isCreating}
            className="!h-9 min-w-[64px]"
          >
            {isCreating ? 'Creating...' : 'Create'}
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
