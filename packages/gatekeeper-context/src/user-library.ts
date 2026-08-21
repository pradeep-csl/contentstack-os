// Per-account index of owned private collections. Public collections live in the domain registry/KV.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  ContextCollectionSummary, ContextCollectionVisibility, isVisibleInWorkspace,
  MAX_SCOPED_COLLECTIONS_PER_WORKSPACE, OwnedCollectionRecord,
} from "./context-types.js";
import { listPublicCollectionsFromKv } from "./collection-kv.js";

type OwnedRecord = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  // Absent on every record written before workspace visibility existed, which `isVisibleInWorkspace`
  // reads as "enabled everywhere" — so old collections keep behaving exactly as they did.
  scopedToWorkspace?: string;
  lastUpdated: Date;
};

function makeUserLibraryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      ownedCollections: collection<OwnedRecord>()({ primaryKey: "id" }),
    },
    singletons: {},
  });
}

export class UserLibraryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ReturnType<typeof makeUserLibraryStorage>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeUserLibraryStorage(ctx.storage);
  }

  // --- Private collections (the user's own) ---

  createOwnedCollection(
      id: string, title: string, description: string, icon?: string,
      scopedToWorkspace?: string): void {
    if (scopedToWorkspace) this.#assertScopeBudget(scopedToWorkspace);
    this.storage.ownedCollections.put({
      id, title, description, icon, scopedToWorkspace, lastUpdated: new Date(),
    });
  }

  // Bounds one workspace's enabled set; see MAX_SCOPED_COLLECTIONS_PER_WORKSPACE.
  #assertScopeBudget(workspaceId: string): void {
    let count = 0;
    for (let record of this.storage.ownedCollections.list()) {
      if (record.scopedToWorkspace === workspaceId) count++;
    }
    if (count >= MAX_SCOPED_COLLECTIONS_PER_WORKSPACE) {
      throw new RangeError(
        `This workspace already has too many Context collections ` +
        `(limit ${MAX_SCOPED_COLLECTIONS_PER_WORKSPACE}).`);
    }
  }

  /** Refresh the denormalized owned record, including its workspace scope. */
  updateOwnedCollection(id: string, summary: ContextCollectionSummary): void {
    let record = this.storage.ownedCollections.get(id);
    if (record) {
      record.title = summary.title;
      record.description = summary.description;
      record.icon = summary.icon;
      // Carried explicitly: this method rebuilds the record from the summary, so omitting it would
      // silently drop the scope on the next metadata edit.
      record.scopedToWorkspace = summary.workspaceId;
      record.lastUpdated = summary.lastUpdated;
      this.storage.ownedCollections.put(record);
    }
  }

  removeOwnedCollection(id: string): void {
    this.storage.ownedCollections.delete(id);
  }

  /** Wipe this library after the caller deletes owned collection content. */
  async deleteAll(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  hasOwned(id: string): boolean {
    return !!this.storage.ownedCollections.get(id);
  }

  listOwnedCollections(): OwnedCollectionRecord[] {
    let result = [...this.storage.ownedCollections.list()].map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      icon: r.icon,
      scopedToWorkspace: r.scopedToWorkspace,
      lastUpdated: r.lastUpdated,
    }));
    result.sort((a, b) => b.lastUpdated.valueOf() - a.lastUpdated.valueOf());
    return result;
  }

  // --- Enabled set (own private + every public collection) ---

  /**
   * Enabled collection visibility for the agent read path, as seen from `workspaceId`. Owned wins on
   * overlap so private is never downgraded to public. Collections scoped to a *different* workspace
   * are excluded, which is what makes workspace visibility exclusive rather than additive; passing
   * no `workspaceId` excludes every scoped collection.
   */
  async getEnabledCollections(
      domain: string, workspaceId?: string): Promise<Map<string, ContextCollectionVisibility>> {
    let result = new Map<string, ContextCollectionVisibility>();
    for (let record of this.storage.ownedCollections.list()) {
      if (!isVisibleInWorkspace(record.scopedToWorkspace, workspaceId)) continue;
      result.set(record.id, record.scopedToWorkspace ? "workspace" : "private");
    }
    for (let entry of await listPublicCollectionsFromKv(this.env, domain)) {
      if (!result.has(entry.id)) result.set(entry.id, "public");
    }
    return result;
  }
}
