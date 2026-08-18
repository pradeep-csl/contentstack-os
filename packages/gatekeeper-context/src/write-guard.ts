// The web CRUD path's read-only guard, extracted pure so it is unit-testable without a Durable
// Object (see document-path.ts for the same rationale). Asserting this over a real RPC stub would
// mean asserting a rejection across the Durable Object RPC boundary, which the Workers test pool
// reports as an unhandled rejection even when the caller catches it — so the decision lives here,
// and only the throw remains on the DO.

import type { ContextCollectionContent } from "./context-types.js";

// The error message to reject a web write with, or null if the source may be written via the web
// CRUD path.
export function webWriteRejection(source: ContextCollectionContent["source"]): string | null {
  if (source === "git") {
    return "Git-based collections are read-only. All changes must be made through git.";
  }
  if (source === "push") {
    return "CI-published collections are read-only. All changes must be made through CI.";
  }
  return null;
}
