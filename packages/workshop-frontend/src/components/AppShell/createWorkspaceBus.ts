// Same decoupling trick as commandPaletteBus: the create-workspace dialog is mounted once inside
// SidebarWorkspacesProvider (the only place that can splice the new workspace into the rail's list
// state), but the button that opens it lives in the /workspaces route, which renders in a sibling
// subtree outside that provider. An event avoids widening the provider to wrap the whole tree.
export const OPEN_CREATE_WORKSPACE_EVENT = 'gadgets:open-create-workspace'

export function openCreateWorkspace(): void {
  window.dispatchEvent(new CustomEvent(OPEN_CREATE_WORKSPACE_EVENT))
}
