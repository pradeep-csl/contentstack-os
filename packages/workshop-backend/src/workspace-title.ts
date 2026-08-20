import { DEFAULT_WORKSPACE_TITLE } from "@gadgets/workshop-shared/api";

// Workspaces created before the gadget-to-workspace rename started out with this title. Old records
// still carry it, so auto-naming has to treat it as a default too.
const LEGACY_DEFAULT_GADGET_TITLE = "Untitled Gadget";

/**
 * True when `title` is a system-assigned default that auto-naming is free to overwrite. Anything
 * else was typed by a person -- at creation (createWorkspace) or later (setTitle) -- and must
 * survive both the first-chat rename and the first-code-merge rename.
 */
export function isReplaceableWorkspaceTitle(title: string): boolean {
  return title === DEFAULT_WORKSPACE_TITLE || title === LEGACY_DEFAULT_GADGET_TITLE;
}
