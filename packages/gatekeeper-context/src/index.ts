// Context Library worker: private per-account collections plus public per-domain collections. The
// vendor auto-provisions accounts that expose a read-only agent singleton and a management UI.

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  INGEST_PATH_PREFIX, type IngestRoute, handleIngestRequest, isCollectionId, parseIngestPath,
} from "./ingest-handler.js";
import { VENDOR_ID } from "./context-types.js";
import { domainName } from "./domain.js";
import { obsContext } from "./observability.js";

export { ContextCollectionDurableObject } from "./context-collection.js";
export { UserLibraryDurableObject } from "./user-library.js";
export { LibraryRegistryDurableObject } from "./registry-do.js";
export {
  GatekeeperVendor, ContextAccount, ContextVerifier, ContextGatekeeper,
} from "./library-gatekeeper.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

// The whole endpoint's share of the coarse limiter. A constant, because what it bounds is exactly
// what a per-collection key cannot: requests spread across collection ids, and requests that address
// no collection at all.
const INGEST_GLOBAL_LIMIT_KEY = "ingest";

// An absent binding means the check is skipped, which is how local dev and tests without a limiter
// configured behave.
async function withinLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  return !limiter || (await limiter.limit({ key })).success;
}

/**
 * The only HTTP surface this worker serves is CI ingestion; everything else reaches it over RPC/DOs.
 * A WorkerEntrypoint rather than a plain handler, because the collection DOs are reached through
 * ctx.exports (this worker declares no durable_objects binding).
 */
export default class extends WorkerEntrypoint<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    let pathname = new URL(request.url).pathname;

    // Bound the endpoint before resolving anything: resolving instantiates a Durable Object for
    // whatever path was requested, so an unauthenticated caller must not reach it unthrottled.
    if (pathname.startsWith(INGEST_PATH_PREFIX)) {
      let route = parseIngestPath(pathname);
      let exceeded = await this.#exceededIngestLimit(route);
      if (exceeded) {
        logger.warn("rejected a rate-limited ingestion request", {
          event: "context.ingest.rejected",
          operation: route?.action,
          // Only once it can name a real collection: before that it is unbounded caller input, and
          // an enumerating caller is precisely who trips this limit.
          collectionId: route && isCollectionId(route.collectionId) ? route.collectionId : undefined,
          outcome: "rate-limited",
          // Which ceiling: one noisy repository reads very differently from a flood spread across
          // collections, and telling them apart is why the global limiter exists.
          limiter: exceeded,
        });
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429, headers: { "content-type": "application/json" },
        });
      }
    }

    let collections = this.ctx.exports.ContextCollectionDurableObject;
    let response = await handleIngestRequest(request, (domain, collectionId) =>
      collections.get(collections.idFromName(domainName(domain, collectionId))));
    if (response) return response;

    return new Response("Context Library worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  }

  // A global ceiling, then a per-collection budget. The per-collection key is the decoded Durable
  // Object name — the identity the handler resolves — so the several spellings of one path
  // (`…/plan`, `…//plan`, `…/%70lan`) share one budget instead of minting three. That key alone
  // cannot bound a caller walking collection ids, since each id gets a fresh budget, which is what
  // the global one is for. Returns which ceiling was exceeded, or null when the request is within
  // both.
  async #exceededIngestLimit(route: IngestRoute | null): Promise<"global" | "collection" | null> {
    if (!await withinLimit(this.env.INGEST_GLOBAL_RATE_LIMITER, INGEST_GLOBAL_LIMIT_KEY)) {
      return "global";
    }
    if (!route) return null;
    let within = await withinLimit(
      this.env.INGEST_RATE_LIMITER, domainName(route.domain, route.collectionId));
    return within ? null : "collection";
  }
}
