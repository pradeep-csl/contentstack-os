import { useEffect, useState } from 'react'

/** One selectable workspace. Only workspaces the user owns are ever listed. */
export type PickableWorkspace = { id: string; title: string }

/**
 * Workshop-owned workspace picker, presented on behalf of a sandboxed gatekeeper app.
 *
 * The app never receives the list — only the single workspace the user picks. This keeps the
 * host-bridge invariant that the frame learns nothing it was not handed (see
 * SandboxedGatekeeperApp's resolveWorkspaceTitles: "Deliberately a lookup, not an enumeration").
 *
 * The listing is supplied rather than fetched here: the frame decides how often this opens, so it
 * shares the host's bounded-lifetime gadget listing instead of a request per open.
 */
export default function GatekeeperWorkspacePicker({
  listWorkspaces,
  onPick,
}: {
  listWorkspaces: () => Promise<PickableWorkspace[]>
  onPick: (workspace: PickableWorkspace | null) => void
}) {
  const [workspaces, setWorkspaces] = useState<PickableWorkspace[] | null>(null)

  useEffect(() => {
    let cancelled = false
    listWorkspaces()
      .then((owned) => {
        if (!cancelled) setWorkspaces(owned)
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([])
      })
    return () => {
      cancelled = true
    }
  }, [listWorkspaces])

  return (
    <div
      className="fixed inset-0 z-[2147483001] flex items-center justify-center bg-black/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a workspace"
    >
      <div className="w-full max-w-md rounded-xl bg-kumo-base p-5 shadow-xl">
        <h2 className="text-ui-lg font-semibold text-kumo-strong">Choose a workspace</h2>
        <p className="mt-1 text-ui-sm text-kumo-subtle">
          Everyone chatting in the workspace you pick can use this collection.
        </p>

        <div className="mt-4 flex max-h-72 flex-col gap-1 overflow-y-auto">
          {workspaces === null ? (
            <p className="px-2 py-3 text-ui-sm text-kumo-subtle">Loading…</p>
          ) : workspaces.length === 0 ? (
            <p className="px-2 py-3 text-ui-sm text-kumo-subtle">
              You don’t own any workspaces yet. Create one first.
            </p>
          ) : (
            workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                data-testid="workspace-option"
                onClick={() => onPick(workspace)}
                className="rounded-lg px-3 py-2 text-left text-ui-md text-kumo-default hover:bg-kumo-fill"
              >
                {workspace.title}
              </button>
            ))
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            data-testid="workspace-picker-cancel"
            onClick={() => onPick(null)}
            className="rounded-lg border border-kumo-line px-3 py-1.5 text-ui-sm font-medium"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
