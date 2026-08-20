// Per-domain registry of public collections. It serializes writes to the KV snapshot read by user
// sessions when building their enabled collection set.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { ContextCollectionSummary } from "./context-types.js";
import { publicCollectionsKvKey } from "./collection-kv.js";

function makeRegistryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      publicCollections: collection<ContextCollectionSummary>()({
        primaryKey: "id",
      }),
    },
    singletons: {},
  });
}

export class LibraryRegistryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ReturnType<typeof makeRegistryStorage>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeRegistryStorage(ctx.storage);
  }

  async #writeSnapshot(domain: string): Promise<void> {
    let collections = [...this.storage.publicCollections.list()];
    await this.env.CONTEXT_COLLECTIONS.put(
      publicCollectionsKvKey(domain), JSON.stringify(collections));
  }

  isPublic(collectionId: string): boolean {
    return !!this.storage.publicCollections.get(collectionId);
  }

  async addPublic(domain: string, summary: ContextCollectionSummary): Promise<void> {
    this.storage.publicCollections.put(summary);
    await this.#writeSnapshot(domain);
  }

  async removePublic(domain: string, collectionId: string): Promise<void> {
    if (this.storage.publicCollections.get(collectionId)) {
      this.storage.publicCollections.delete(collectionId);
      await this.#writeSnapshot(domain);
    }
  }

  /**
   * Refresh a public collection summary; no-op if it is no longer public.
   *
   * Every publication changes `documentCount` and `lastUpdated`, so triggering the KV rewrite on
   * those would make every publish in the domain rewrite this one shared snapshot key — and KV
   * permits roughly one write/sec to a single key, so concurrent publishes would contend on it. The
   * snapshot's actual consumers (`getEnabledCollections`, `loadEnabledContextCollections`) never
   * read `documentCount`, and only use `lastUpdated` for presentation recency, so we only rewrite
   * when a field a consumer reads for identity — title, description, icon, visibility — has
   * changed. Trade-off, deliberately accepted: `documentCount` and `lastUpdated` in the snapshot go
   * stale between identity edits. Membership (`addPublic`/`removePublic`) is unaffected and still
   * writes unconditionally.
   */
  async syncPublic(domain: string, summary: ContextCollectionSummary): Promise<void> {
    let existing = this.storage.publicCollections.get(summary.id);
    if (!existing) return;
    let identityChanged = existing.title !== summary.title
      || existing.description !== summary.description
      || existing.icon !== summary.icon
      || existing.visibility !== summary.visibility;
    if (identityChanged) {
      this.storage.publicCollections.put(summary);
      await this.#writeSnapshot(domain);
    }
  }
}
