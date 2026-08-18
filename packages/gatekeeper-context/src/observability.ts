import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the Context gatekeeper. */
export type ContextObservabilityFields = {
  added: number;
  bodyBytes: number;
  branch: string;
  collectionId: string;
  commit: string;
  deleted: number;
  dir: string;
  filepath: string;
  // Which ingestion ceiling a 429 came from: "global" or "collection".
  limiter: string;
  maxBodyBytes: number;
  maxGitDirBytes: number;
  operation: string;
  // Why a request was refused, e.g. "bad-token" or "rate-limited". Never the cause's contents.
  outcome: string;
  // How many documents in an upload batch were refused, and the distinct reasons.
  reasons: string;
  rejected: number;
  repoName: string;
  sizeBytes: number;
  tokenId: number | string;
  updated: number;
  vendorId: string;
};

/** Ambient observability fields for one Context gatekeeper operation. */
export const obsContext = createObservabilityContext<ContextObservabilityFields>();
