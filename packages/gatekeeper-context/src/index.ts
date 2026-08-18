// Context Library worker: private per-account collections plus public per-domain collections. The
// vendor auto-provisions accounts that expose a read-only agent singleton and a management UI.

import { WorkerEntrypoint } from "cloudflare:workers";
import { INGEST_PATH_PREFIX, handleIngestRequest } from "./ingest-handler.js";
import { domainName } from "./domain.js";

export { ContextCollectionDurableObject } from "./context-collection.js";
export { UserLibraryDurableObject } from "./user-library.js";
export { LibraryRegistryDurableObject } from "./registry-do.js";
export {
  GatekeeperVendor, ContextAccount, ContextVerifier, ContextGatekeeper,
} from "./library-gatekeeper.js";

// The only HTTP surface this worker serves is CI ingestion; everything else reaches it over RPC/DOs.
// A WorkerEntrypoint rather than a plain handler, because the collection DOs are reached through
// ctx.exports (this worker declares no durable_objects binding).
export default class extends WorkerEntrypoint<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    // Bound the endpoint before resolving anything: resolving instantiates a Durable Object for
    // whatever path was requested, so an unauthenticated caller must not reach it unthrottled.
    if (new URL(request.url).pathname.startsWith(INGEST_PATH_PREFIX) && this.env.INGEST_RATE_LIMITER) {
      let { success } = await this.env.INGEST_RATE_LIMITER.limit({ key: new URL(request.url).pathname });
      if (!success) {
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
}
