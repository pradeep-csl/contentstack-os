import { createFileRoute } from '@tanstack/react-router'
import { Plus } from '@phosphor-icons/react'
import GadgetList from '../components/GadgetList'
import { openCreateWorkspace } from '../components/AppShell/createWorkspaceBus'
import { useDocumentTitle } from '../useDocumentTitle'

/**
 * Full workspace listing. The sidebar surfaces Favorites + a handful of Recent workspaces; this is
 * the "see them all" destination linked from the rail.
 */
export const Route = createFileRoute('/workspaces')({
  component: WorkspacesPage,
})

function WorkspacesPage() {
  useDocumentTitle('Workspaces')
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 sm:px-10">
      <header className="flex items-end justify-between gap-4 px-3 pb-3 pt-10">
        <div className="min-w-0">
          <h1 className="text-ui-3xl font-semibold text-kumo-strong">Workspaces</h1>
          <p className="mt-1 text-ui-md text-kumo-subtle">
            Each workspace is an isolated environment with its own conversations, gatekeepers, and outputs.
          </p>
        </div>
        {/* Opens the name dialog owned by SidebarWorkspacesProvider, which creates the workspace,
            shows it in the rail immediately, and navigates into it. */}
        <button
          type="button"
          onClick={() => openCreateWorkspace()}
          className="press inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-ui-sm font-medium text-white transition-colors hover:bg-kumo-brand-hover"
        >
          <Plus size={14} weight="bold" />
          Create workspace
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <GadgetList showHeader={false} />
      </div>
    </div>
  )
}
