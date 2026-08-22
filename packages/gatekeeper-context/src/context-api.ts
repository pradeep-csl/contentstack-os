// Per-account management API exposed to the library iframe. Users manage their own private
// collections; admins also manage public collections. Everything is sharing-domain scoped.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import {
  ContextApi, ContextCollectionContent, ContextCollectionMetadata, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary, ContextGitTokenCreateResult, ContextGitTokenList,
  ContextIngestTokenCreateResult, ContextIngestTokenList,
  DEFAULT_GIT_BRANCH, EnabledCollectionInfo, isVisibleInWorkspace,
} from "./context-types.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { UserLibraryDurableObject } from "./user-library.js";
import type { LibraryRegistryDurableObject } from "./registry-do.js";
import {
  listPublicCollectionsFromKv, metadataToSummary,
} from "./collection-kv.js";
import { domainName } from "./domain.js";

/**
 * The unfiltered management listing: every collection this account owns (private or
 * workspace-scoped) plus every public collection in the domain. Used for the account's own
 * library page, where a workspace-scoped collection must still show up for its creator.
 */
export async function loadEnabledContextCollections(
    env: Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">,
    domain: string,
    userLibrary: DurableObjectStub<UserLibraryDurableObject>): Promise<EnabledCollectionInfo[]> {
  let [owned, publicCollections] = await Promise.all([
    userLibrary.listOwnedCollections(),
    listPublicCollectionsFromKv(env, domain),
  ]);

  let result: EnabledCollectionInfo[] = [];
  let seen = new Set<string>();
  for (let collection of owned) {
    seen.add(collection.id);
    result.push({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      icon: collection.icon,
      source: "private",
      workspaceId: collection.scopedToWorkspace,
      lastUpdated: collection.lastUpdated,
    });
  }
  for (let collection of publicCollections) {
    if (seen.has(collection.id)) continue;
    seen.add(collection.id);
    result.push({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      icon: collection.icon,
      source: "public",
      lastUpdated: collection.lastUpdated,
    });
  }
  return result;
}

/**
 * The collections an agent acting in `workspaceId` may use: the management listing minus every
 * collection scoped to a different workspace. Public collections carry no scope and always pass.
 */
export async function loadAgentContextCollections(
    env: Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">,
    domain: string,
    userLibrary: DurableObjectStub<UserLibraryDurableObject>,
    workspaceId: string): Promise<EnabledCollectionInfo[]> {
  return (await loadEnabledContextCollections(env, domain, userLibrary))
      .filter(collection => isVisibleInWorkspace(collection.workspaceId, workspaceId));
}

// A Durable Object ID string, which is what a workspace ID is. The iframe supplies it, so its shape
// is checked here, at the API boundary, before it reaches a collection's metadata or the
// owner-library record. The Durable Objects themselves stay unvalidated: they are internal, and a
// malformed scope there is only ever unreadable, never a grant (see the design doc §7.1).
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Rejects a workspace id the frame cannot have obtained from the host picker. */
function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("That is not a valid workspace id.");
  }
}

@validateRpc()
export class ContextApiImpl extends RpcTarget implements ContextApi {
  constructor(
    private env: Cloudflare.Env,
    private domain: string,
    private accountId: string,
    private isAdmin: boolean,
    private collections: DurableObjectNamespace<ContextCollectionDurableObject>,
    private userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    private registries: DurableObjectNamespace<LibraryRegistryDurableObject>,
  ) {
    super();
  }

  #collection(id: string) {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  #userLib() {
    return this.userLibraries.get(this.userLibraries.idFromName(domainName(this.domain, this.accountId)));
  }

  #registry() {
    return this.registries.getByName(this.domain);
  }

  // Whether this account owns the private collection.
  async #ownsPrivate(collectionId: string): Promise<boolean> {
    return this.#userLib().hasOwned(collectionId);
  }

  // Read: own private collections or any public collection.
  async #assertCanRead(collectionId: string): Promise<void> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    if (!owns && !isPublic) {
      throw new Error("Collection not found or you don't have access.");
    }
  }

  // Write: own private collections, or public collections for admins.
  async #assertCanWrite(collectionId: string): Promise<void> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    if (owns) return;
    if (isPublic && this.isAdmin) return;
    throw new Error("Collection not found or you don't have access.");
  }

  #assertArtifactsAvailable(): void {
    if (!this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }
  }

  #assertAdmin(): void {
    if (!this.isAdmin) throw new Error("Admin access required.");
  }

  async getViewerInfo(): Promise<{ isAdmin: boolean; supportsGitCollections: boolean }> {
    return { isAdmin: this.isAdmin, supportsGitCollections: !!this.env.ARTIFACTS };
  }

  // --- Collection management ---

  async createContextCollection(
    title: string,
    description: string,
    visibility: ContextCollectionVisibility,
    icon?: string,
    source: ContextCollectionContent["source"] = "web",
    workspaceId?: string,
  ): Promise<ContextCollectionMetadata> {
    if (visibility === "public") this.#assertAdmin();
    if (visibility === "workspace") {
      if (!workspaceId) throw new Error("A workspace must be chosen for a workspace collection.");
      assertWorkspaceId(workspaceId);
    } else if (workspaceId) {
      throw new Error("Only workspace-scoped collections accept a workspace id.");
    }
    if (source !== "web" && source !== "git" && source !== "push") {
      throw new Error(`Unsupported collection source: ${source}`);
    }
    if (source === "git" && !this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }

    let id = crypto.randomUUID();
    let metadata: ContextCollectionMetadata = {
      id,
      icon,
      title,
      description,
      visibility,
      workspaceId,
      created: new Date(),
      lastUpdated: new Date(),
      documentCount: 0,
      content: source === "git"
        ? { source, remote: "", branch: DEFAULT_GIT_BRANCH, lastRefreshedAt: new Date() }
        : { source },
    };

    // Initialize before indexing; if this fails, nothing is reachable yet. A workspace collection
    // has a creator-owner exactly like a private one — that is what keeps it writable by them.
    metadata = await this.#collection(id).initialize(
      metadata, this.domain, visibility === "public" ? "" : this.accountId);

    // Public collections live in the domain registry; private and workspace-scoped ones live in the
    // owner's library, the latter carrying their scope.
    try {
      if (visibility === "public") {
        await this.#registry().addPublic(this.domain, metadataToSummary(metadata));
      } else {
        await this.#userLib().createOwnedCollection(id, title, description, icon, workspaceId);
      }
    } catch (err) {
      // Indexing failed; delete the now-unreachable collection.
      await this.#collection(id).deleteSelf().catch(() => {});
      throw err;
    }
    return metadata;
  }

  async updateContextCollection(collectionId: string, options: {
    title?: string; description?: string; icon?: string; branch?: string;
  }): Promise<void> {
    await this.#assertCanWrite(collectionId);
    if (options.branch !== undefined) this.#assertArtifactsAvailable();
    await this.#collection(collectionId).updateMetadata(options);
  }

  async syncContextCollectionArtifactSource(collectionId: string): Promise<void> {
    // Only collection owners/admins can manually trigger an artifact
    // sync. Read requests from non-owners/admins may trigger a
    // stale-while-revalidate sync in the background, but they do not
    // have direct control over this.
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    await this.#collection(collectionId).syncArtifactSource();
  }

  async createContextCollectionGitToken(collectionId: string): Promise<ContextGitTokenCreateResult> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).createGitToken();
  }

  async listContextCollectionGitTokens(collectionId: string): Promise<ContextGitTokenList> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).listGitTokens();
  }

  async revokeContextCollectionGitToken(collectionId: string, tokenId: string): Promise<boolean> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).revokeGitToken(tokenId);
  }

  /**
   * CI ingestion tokens are independent of the Artifacts binding: unlike the git token methods
   * above, push-sourced collections don't need it, so there's no #assertArtifactsAvailable() call.
   */
  async createContextCollectionIngestToken(
      collectionId: string): Promise<ContextIngestTokenCreateResult> {
    await this.#assertCanWrite(collectionId);
    return this.#collection(collectionId).createIngestToken();
  }

  async listContextCollectionIngestTokens(collectionId: string): Promise<ContextIngestTokenList> {
    await this.#assertCanWrite(collectionId);
    return this.#collection(collectionId).listIngestTokens();
  }

  async revokeContextCollectionIngestToken(
      collectionId: string, tokenId: string): Promise<boolean> {
    await this.#assertCanWrite(collectionId);
    return this.#collection(collectionId).revokeIngestToken(tokenId);
  }

  async deleteContextCollection(collectionId: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).deleteSelf();
  }

  async setContextCollectionWorkspace(collectionId: string, workspaceId: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    let workspace = workspaceId?.trim();
    if (!workspace) throw new Error("A workspace must be chosen to share this collection.");
    assertWorkspaceId(workspace);
    // A public collection is domain-owned and has no owner library to carry a scope, so scoping it
    // would strand it in an index nothing reads. The per-workspace cap needs no check here:
    // updateOwnedCollection consults it on every scope change, which is what propagation performs.
    let metadata = await this.#collection(collectionId).getMetadata();
    if (metadata.visibility === "public") {
      throw new Error("A collection shared with everyone can't be scoped to a workspace.");
    }
    await this.#collection(collectionId).setWorkspaceScope(workspace);
  }

  async revokeContextCollectionWorkspace(collectionId: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).clearWorkspaceScope();
  }

  async getContextCollectionMetadata(collectionId: string): Promise<ContextCollectionMetadata | null> {
    try {
      let [meta, owns, isPublic] = await Promise.all([
        this.#collection(collectionId).getMetadata(),
        this.#ownsPrivate(collectionId),
        this.#registry().isPublic(collectionId),
      ]);
      if (!meta.id || (!owns && !isPublic)) return null;
      return meta;
    } catch {
      return null;
    }
  }

  // --- Document editing ---

  async listContextDocuments(collectionId: string, prefix?: string): Promise<ContextDocumentSummary[]> {
    await this.#assertCanRead(collectionId);
    return this.#collection(collectionId).listContextDocuments(prefix);
  }

  async getContextDocument(collectionId: string, path: string): Promise<ContextDocument | null> {
    await this.#assertCanRead(collectionId);
    return this.#collection(collectionId).getContextDocument(path);
  }

  async putContextDocument(collectionId: string, path: string, doc: {
    description: string; body: string; contentType?: string;
  }): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).putContextDocument(path, doc);
  }

  async deleteContextDocument(collectionId: string, path: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).deleteContextDocument(path);
  }

  async moveContextDocument(collectionId: string, fromPath: string, toPath: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).moveContextDocument(fromPath, toPath);
  }

  // --- Listing & access ---

  async listEnabledContextCollections(): Promise<EnabledCollectionInfo[]> {
    return loadEnabledContextCollections(this.env, this.domain, this.#userLib());
  }

  async canWriteContextCollection(collectionId: string): Promise<boolean> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    return owns || (isPublic && this.isAdmin);
  }
}
