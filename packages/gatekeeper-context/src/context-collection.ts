// One collection's metadata and documents. Metadata changes update the private owner library or the
// public domain registry.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  ContextCollectionContent, ContextCollectionMetadata, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary,
  ContextGitTokenCreateResult, ContextGitTokenList,
  ContextIngestTokenCreateResult, ContextIngestTokenList,
  DEFAULT_DOCUMENT_CONTENT_TYPE, DEFAULT_GIT_BRANCH, MAX_DOCUMENT_BODY_BYTES,
  contentTypeFromPath, isTextContentType, VENDOR_ID,
} from "./context-types.js";
import { metadataToSummary } from "./collection-kv.js";
import { domainName } from "./domain.js";
import { readArtifactRepoDocuments } from "./artifact-sync.js";
import {
  isSkillManifestPath, parseSkillManifest, type SkillIndexEntry,
} from "./agent-skill.js";
import { baseName, validateDocumentPath } from "./document-path.js";
import { obsContext } from "./observability.js";
import { webWriteRejection } from "./write-guard.js";
import {
  INGEST_PATH_PREFIX,
  type CommitOutcome, type PlanOutcome, type StageOutcome, type StagedDocument,
} from "./ingest-handler.js";
import { INGEST_TOKEN_TTL_SECONDS, generateIngestToken, hashIngestToken } from "./ingest-token.js";
import { type ManifestEntry, hashManifest, planUploads } from "./ingest-manifest.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

// Git tokens created through the web UI are valid for one year,
// the maximum TTL supported by Artifacts.
const GIT_TOKEN_TTL_SECONDS = 31_536_000;
// Background git refresh happens minutely at most.
const GIT_REFRESH_MIN_INTERVAL_MS = 60_000;
// Allow simple branch names made of alphanumerics, '/', '.', '_', and '-', but not leading/trailing '/'.
const GIT_BRANCH_RE = /^(?!\/)(?!.*\/$)[A-Za-z0-9/._-]{1,255}$/;
// Older collections build this path list on first use. Increase the version when parsing rules
// change.
const SKILL_INDEX_VERSION = 1;

// Lowercased file extension (without the dot), or "" if none.
function extOf(path: string): string {
  let b = baseName(path);
  let i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

type ContextRecord = {
  path: string;
  name: string;
  description: string;
  contentType: string;
  body: string;
  // SHA-256 of the raw bytes, set by CI publication. Absent on documents written before hashing
  // existed, which is why publication treats a missing hash as "must re-send".
  hash?: string;
  lastUpdated: Date;
};

// A live ingestion token. Only the hash is stored, so a storage leak yields nothing usable.
type IngestTokenRecord = {
  id: string;
  hash: string;
  createdAt: Date;
  expiresAt: Date;
};

// The open publication, if any. Deliberately small: persisting the manifest itself would reintroduce
// the per-file write amplification this protocol exists to avoid.
type IngestSession = {
  sessionId: string;
  commit: string;
  manifestHash: string;
  neededCount: number;
};

// Old records that predate git-based collections won't have `content` set in storage.
// Unset `content` is defaulted to { "source": "web" } at the API layer, which is why
// we have different types for storage vs. API interface.
type StoredContextCollectionMetadata = Omit<ContextCollectionMetadata, "content"> & {
  content?: ContextCollectionContent;
};

function makeContextCollectionStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      documents: collection<ContextRecord>()({ primaryKey: "path" }),
      // Data needed to list skills without loading document bodies.
      skillIndex: collection<SkillIndexEntry>()({ primaryKey: "path" }),
      ingestTokens: collection<IngestTokenRecord>()({ primaryKey: "id" }),
      staging: collection<ContextRecord>()({ primaryKey: "path" }),
    },
    singletons: {
      // Sharing domain for cross-DO references.
      sharingDomain: "",
      // Private owner account id; empty for public collections.
      ownerAccountId: "",
      metadata: <StoredContextCollectionMetadata>{
        id: "",
        title: "",
        description: "",
        visibility: "private" as ContextCollectionVisibility,
        created: new Date(0),
        lastUpdated: new Date(0),
        documentCount: 0,
        content: { source: "web" },
      },
      skillIndexVersion: 0,
      ingestSession: <IngestSession>{ sessionId: "", commit: "", manifestHash: "", neededCount: 0 },
    },
  });
}

type ContextCollectionStorage = ReturnType<typeof makeContextCollectionStorage>;

export class ContextCollectionDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ContextCollectionStorage;
  // Set when an artifact refresh operation is in flight. Additional refresh requests should
  // await this promise when set instead of kicking off additional concurrent refreshes.
  #artifactRefresh?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeContextCollectionStorage(ctx.storage);
  }

  // Sharing domain for all cross-DO/KV references.
  #domain(): string {
    return this.storage.sharingDomain.get();
  }

  // The owner's UserLibraryDurableObject (private collections only), within this collection's domain.
  #ownerLibrary() {
    let ns = this.ctx.exports.UserLibraryDurableObject;
    return ns.get(ns.idFromName(domainName(this.#domain(), this.storage.ownerAccountId.get())));
  }

  #registry() {
    let ns = this.ctx.exports.LibraryRegistryDurableObject;
    return ns.getByName(this.#domain());
  }

  #artifacts(): Artifacts {
    let artifacts = this.env.ARTIFACTS;
    if (!artifacts) throw new Error("Git-backed Context collections are not enabled.");
    return artifacts;
  }

  async #createArtifactRepo(metadata: ContextCollectionMetadata): Promise<string> {
    // Artifact repo id is always set to collection id.
    let artifacts = this.#artifacts();
    let created = await artifacts.create(metadata.id, {
      setDefaultBranch: DEFAULT_GIT_BRANCH,
    });

    let repo = await artifacts.get(metadata.id);
    // Artifacts auto-creates an initial write token when the repo is first
    // created. We don't want or need this token, so we immediately revoke it.
    await repo.revokeToken(created.token).catch((err) => {
      logger.warn("failed to revoke initial Artifacts token for context collection", {
        event: "artifacts.initial.token.revoke.failed",
        collectionId: metadata.id,
        error: err,
      });
    });
    return created.remote;
  }

  /**
   * Initialize a new collection. Private collections pass an owner; public collections pass "".
   * Rejects re-initialization so a (vanishingly unlikely) id reuse can't clobber existing content.
   */
  async initialize(metadata: ContextCollectionMetadata, sharingDomain: string, ownerAccountId: string): Promise<ContextCollectionMetadata> {
    if (this.getMetadata().id) {
      throw new Error("Collection already exists.");
    }
    this.storage.sharingDomain.put(sharingDomain);
    this.storage.ownerAccountId.put(ownerAccountId);
    if (metadata.content.source === "git") {
      metadata.content = {
        source: "git",
        remote: await this.#createArtifactRepo(metadata),
        branch: metadata.content.branch,
        lastRefreshedAt: metadata.created,
      };
    }
    this.storage.metadata.put(metadata);
    // A new collection starts with an up-to-date empty path list.
    this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    return metadata;
  }

  getMetadata(): ContextCollectionMetadata {
    let meta = this.storage.metadata.get();
    // Old storage records won't have `content` set, so we need to default these values in
    // at the API layer.
    return { ...meta, content: meta.content ?? { source: "web" } };
  }

  #parseAgentSkill(record: ContextRecord) {
    if (!isSkillManifestPath(record.path) ||
        !isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE)) {
      return undefined;
    }
    try {
      return parseSkillManifest(record.path, record.body);
    } catch {
      return undefined;
    }
  }

  // Update the skill entry after saving a document.
  #updateSkillIndex(record: ContextRecord): void {
    let manifest = this.#parseAgentSkill(record);
    if (manifest) {
      this.storage.skillIndex.put({
        path: record.path,
        skillName: manifest.name,
        description: manifest.description,
      });
    } else {
      this.storage.skillIndex.delete(record.path);
    }
  }

  // Save a document and update its skill entry together.
  #putDocument(record: ContextRecord): void {
    this.storage.documents.put(record);
    this.#updateSkillIndex(record);
  }

  // Delete a document and its skill entry together.
  #deleteDocument(path: string): void {
    this.storage.documents.delete(path);
    this.storage.skillIndex.delete(path);
  }

  #clearSkillIndex(): void {
    // Read the entries before deleting from the same storage collection.
    for (let entry of Array.from(this.storage.skillIndex.list())) {
      this.storage.skillIndex.delete(entry.path);
    }
  }

  // Build the index for collections created before it existed.
  #ensureSkillIndex(): void {
    if (this.storage.skillIndexVersion.get() === SKILL_INDEX_VERSION) return;

    let entries: SkillIndexEntry[] = [];
    for (let record of this.storage.documents.list()) {
      let manifest = this.#parseAgentSkill(record);
      if (manifest) {
        entries.push({
          path: record.path,
          skillName: manifest.name,
          description: manifest.description,
        });
      }
    }

    this.storage.transaction(() => {
      this.#clearSkillIndex();
      for (let entry of entries) {
        this.storage.skillIndex.put(entry);
      }
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  listAgentSkills(): SkillIndexEntry[] {
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();
    this.#ensureSkillIndex();
    return [...this.storage.skillIndex.list()];
  }

  async updateMetadata(options: {
    title?: string;
    description?: string;
    icon?: string;
    branch?: string;
  }): Promise<void> {
    let meta = this.getMetadata();
    let changed = false;

    if (options.title !== undefined && options.title !== meta.title) { meta.title = options.title; changed = true; }
    if (options.description !== undefined && options.description !== meta.description) { meta.description = options.description; changed = true; }
    if (options.icon !== undefined && options.icon !== meta.icon) { meta.icon = options.icon; changed = true; }
    if (options.branch !== undefined) {
      if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
      let branch = options.branch.trim();
      if (!GIT_BRANCH_RE.test(branch)) throw new Error("Git branch is invalid.");
      if (branch !== meta.content.branch) {
        meta.content.branch = branch;
        delete meta.content.commit;
        changed = true;
      }
    }

    if (changed) {
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
      await this.#propagate();
    }
  }

  // --- Document CRUD ---

  #assertWebWritable(): void {
    let rejection = webWriteRejection(this.getMetadata().content.source);
    if (rejection) throw new Error(rejection);
  }

  async listContextDocuments(prefix?: string): Promise<ContextDocumentSummary[]> {
    // Trigger git mirror revalidation in the background on reads.
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();
    let options = prefix ? { prefix } : undefined;
    let result: ContextDocumentSummary[] = [];
    for (let record of this.storage.documents.list(options)) {
      let manifest = this.#parseAgentSkill(record);
      result.push({
        path: record.path,
        name: record.name,
        description: manifest?.description ?? record.description,
        contentType: record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE,
        ...(manifest ? {skillName: manifest.name} : {}),
        lastUpdated: record.lastUpdated,
      });
    }
    return result;
  }

  /** Lenient read: bad/missing paths return null, not RPC errors. Mutations validate paths. */
  async getContextDocument(path: string): Promise<ContextDocument | null> {
    // Trigger git mirror revalidation in the background on reads.
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();

    let record = this.storage.documents.get(path);
    if (!record) return null;
    let contentType = record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE;
    let manifest = this.#parseAgentSkill(record);
    return {
      path: record.path,
      name: record.name,
      description: manifest?.description ?? record.description,
      contentType,
      body: record.body,
      ...(manifest ? {skillName: manifest.name} : {}),
      lastUpdated: record.lastUpdated,
    };
  }

  async putContextDocument(
      path: string,
      doc: { description: string; body: string; contentType?: string }): Promise<void> {
    this.#assertWebWritable();
    validateDocumentPath(path);
    // Enforce real UTF-8 bytes, not UTF-16 code units.
    let byteLength = new TextEncoder().encode(doc.body).length;
    if (byteLength > MAX_DOCUMENT_BODY_BYTES) {
      throw new Error(`Document is too large (${byteLength} bytes; max ${MAX_DOCUMENT_BODY_BYTES}).`);
    }

    let contentType = doc.contentType || contentTypeFromPath(path);
    let record: ContextRecord = {
      path, name: baseName(path), description: doc.description, contentType, body: doc.body, lastUpdated: new Date(),
    };

    this.storage.transaction(() => {
      let isNew = !this.storage.documents.get(path);
      // Use the file name from the path as the display name.
      this.#putDocument(record);

      let meta = this.getMetadata();
      if (isNew) meta.documentCount++;
      meta.lastUpdated = record.lastUpdated;
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  async deleteContextDocument(path: string): Promise<void> {
    this.#assertWebWritable();
    // Mutations reject invalid paths; reads stay lenient.
    validateDocumentPath(path);
    let existing = this.storage.documents.get(path);
    if (!existing) throw new Error(`Document not found: ${path}`);

    this.storage.transaction(() => {
      this.#deleteDocument(path);

      let meta = this.getMetadata();
      meta.documentCount = Math.max(0, meta.documentCount - 1);
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  async moveContextDocument(from: string, to: string): Promise<void> {
    this.#assertWebWritable();
    validateDocumentPath(from);
    validateDocumentPath(to);
    if (from === to) return;

    // Reject moving a folder into one of its own descendants.
    if (to.startsWith(from + "/")) {
      throw new Error("Cannot move a folder into itself.");
    }

    let moves: { record: ContextRecord; newPath: string }[] = [];
    let exact = this.storage.documents.get(from);
    if (exact) {
      moves.push({ record: exact, newPath: to });
    } else {
      let fromPrefix = from.endsWith("/") ? from : from + "/";
      let toPrefix = to.endsWith("/") ? to : to + "/";
      for (let record of this.storage.documents.list({ prefix: fromPrefix })) {
        moves.push({ record, newPath: toPrefix + record.path.slice(fromPrefix.length) });
      }
    }

    if (moves.length === 0) throw new Error(`Nothing to move at: ${from}`);

    let movedFrom = new Set(moves.map(m => m.record.path));
    for (let m of moves) {
      if (!movedFrom.has(m.newPath) && this.storage.documents.get(m.newPath)) {
        throw new Error(`Destination already exists: ${m.newPath}`);
      }
    }

    this.storage.transaction(() => {
      for (let m of moves) {
        this.#deleteDocument(m.record.path);
      }
      for (let m of moves) {
        // Update the file name and content type for the new path.
        let contentType = extOf(m.record.path) !== extOf(m.newPath)
          ? contentTypeFromPath(m.newPath)
          : m.record.contentType;
        let record: ContextRecord = {
          ...m.record,
          path: m.newPath,
          name: baseName(m.newPath),
          contentType,
          lastUpdated: new Date(),
        };
        this.#putDocument(record);
      }

      let meta = this.getMetadata();
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  // --- Artifact-backed projection ---

  async syncArtifactSource(): Promise<void> {
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    await this.#refreshArtifactSource();
  }

  async createGitToken(): Promise<ContextGitTokenCreateResult> {
    let meta = this.getMetadata();
    if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
    let repo = await this.#artifacts().get(meta.id);
    let token = await repo.createToken("write", GIT_TOKEN_TTL_SECONDS);
    return {
      id: token.id,
      plaintext: token.plaintext,
      remote: meta.content.remote,
    };
  }

  async listGitTokens(): Promise<ContextGitTokenList> {
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    let meta = this.getMetadata();
    let repo = await this.#artifacts().get(meta.id);
    let result = await repo.listTokens();
    return {
      tokens: result.tokens
        // User-created tokens for mirror setup are always write tokens. This DO
        // mints its own read tokens for cloning the repo into memory which we
        // don't want to expose the user.
        .filter(token => token.scope === "write" && token.state === "active")
        .map(token => ({
          id: token.id,
          expiresAt: token.expiresAt,
        })),
    };
  }

  async revokeGitToken(tokenId: string): Promise<boolean> {
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    let meta = this.getMetadata();
    let repo = await this.#artifacts().get(meta.id);
    return repo.revokeToken(tokenId);
  }

  #isGitBased(): boolean {
    return this.getMetadata().content.source === "git";
  }

  #startBackgroundArtifactRefresh(): void {
    if (!this.env.ARTIFACTS) return;
    let content = this.getMetadata().content;
    if (content.source !== "git") return;
    if (Date.now() - content.lastRefreshedAt.getTime() < GIT_REFRESH_MIN_INTERVAL_MS) return;

    void this.#refreshArtifactSource().catch((err) => {
      logger.warn("failed to refresh git-based context collection in the background", {
        event: "context.collection.git.refresh.failed",
        collectionId: this.getMetadata().id,
        error: err,
      });
    });
  }

  #refreshArtifactSource(): Promise<void> {
    if (this.#artifactRefresh) return this.#artifactRefresh;

    let promise = this.#loadArtifactSnapshot().finally(() => {
      if (this.#artifactRefresh === promise) this.#artifactRefresh = undefined;
    });
    this.#artifactRefresh = promise;
    return promise;
  }

  #replaceArtifactDocuments(commit: string, documents: ContextDocument[]): void {
    this.storage.transaction(() => {
      for (let record of this.storage.documents.list()) {
        this.storage.documents.delete(record.path);
      }
      this.#clearSkillIndex();
      for (let doc of documents) {
        this.#putDocument(doc);
      }

      let meta = this.getMetadata();
      meta.documentCount = documents.length;
      meta.lastUpdated = new Date();
      if (meta.content.source !== "git") throw new Error("Collection must be git-based.");
      meta.content.commit = commit;
      meta.content.lastRefreshedAt = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  #deleteArtifactDocuments(commit: string): void {
    this.storage.transaction(() => {
      for (let record of this.storage.documents.list()) {
        this.storage.documents.delete(record.path);
      }
      this.#clearSkillIndex();

      let meta = this.getMetadata();
      meta.documentCount = 0;
      meta.lastUpdated = new Date();
      if (meta.content.source !== "git") throw new Error("Collection must be git-based.");
      meta.content.commit = commit;
      meta.content.lastRefreshedAt = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  async #loadArtifactSnapshot(): Promise<void> {
    const meta = this.getMetadata();
    if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
    const result = await readArtifactRepoDocuments(
        this.#artifacts(), meta.id, meta.content.remote, meta.content.branch, meta.content.commit);
    if (!result.changed) {
      // Nothing changed, just bump the refresh timestamp.
      const latestMeta = this.getMetadata();
      if (latestMeta.content.source !== "git") throw new Error("Collection is not git-based.");
      latestMeta.content = { ...latestMeta.content, lastRefreshedAt: new Date() };
      this.storage.metadata.put(latestMeta);
      return;
    }

    if (result.commit) {
      // The repo was updated to a new commit, stored documents need to be updated.
      this.#replaceArtifactDocuments(result.commit, result.documents);
    } else {
      // The repo was updated to an empty state.
      this.#deleteArtifactDocuments(result.commit);
    }
    await this.#propagate();
  }

  // --- CI publication: tokens ---

  async createIngestToken(): Promise<ContextIngestTokenCreateResult> {
    let meta = this.getMetadata();
    if (meta.content.source !== "push") {
      throw new Error("Collection does not accept CI publication.");
    }
    let { id, plaintext } = generateIngestToken();
    let hash = await hashIngestToken(plaintext);
    let now = new Date();

    this.storage.transaction(() => {
      // Revocation deletes, but expiry alone never did, so mint time is where expired rows go.
      for (let existing of Array.from(this.storage.ingestTokens.list())) {
        if (existing.expiresAt.getTime() <= now.getTime()) {
          this.storage.ingestTokens.delete(existing.id);
        }
      }
      this.storage.ingestTokens.put({
        id, hash, createdAt: now,
        expiresAt: new Date(now.getTime() + INGEST_TOKEN_TTL_SECONDS * 1000),
      });
    });

    return {
      id,
      plaintext,
      path: `${INGEST_PATH_PREFIX}${encodeURIComponent(this.#domain())}/` +
          `${encodeURIComponent(meta.id)}`,
    };
  }

  async listIngestTokens(): Promise<ContextIngestTokenList> {
    let now = Date.now();
    return {
      tokens: Array.from(this.storage.ingestTokens.list())
        .filter(token => token.expiresAt.getTime() > now)
        .map(token => ({ id: token.id, expiresAt: token.expiresAt.toISOString() })),
    };
  }

  async revokeIngestToken(tokenId: string): Promise<boolean> {
    if (!this.storage.ingestTokens.get(tokenId)) return false;
    this.storage.ingestTokens.delete(tokenId);
    return true;
  }

  /**
   * Public so the handler can authenticate before reading a request body. Comparing hashes of a
   * high-entropy secret does not need a constant-time compare: a timing leak reveals a hash prefix,
   * which is useless without a preimage.
   */
  async verifyIngestToken(plaintext: string): Promise<boolean> {
    if (!plaintext) return false;
    let hash = await hashIngestToken(plaintext);
    let now = Date.now();
    for (let record of this.storage.ingestTokens.list()) {
      if (record.hash === hash && record.expiresAt.getTime() > now) return true;
    }
    return false;
  }

  // --- CI publication: the protocol ---

  #clearStaging(): void {
    for (let record of Array.from(this.storage.staging.list())) {
      this.storage.staging.delete(record.path);
    }
  }

  #stagedCount(): number {
    let count = 0;
    for (let _ of this.storage.staging.list()) count++;
    return count;
  }

  /** Compare the desired state against what is stored and open a session for the difference. */
  async planIngest(
      commit: string, manifest: ManifestEntry[], allowEmpty: boolean): Promise<PlanOutcome> {
    let meta = this.getMetadata();
    if (meta.content.source !== "push") return { status: "wrong-source" };
    if (meta.content.commit === commit) return { status: "unchanged", commit };
    if (manifest.length === 0 && !allowEmpty) return { status: "empty-refused" };

    // Await before the transaction, never inside it.
    let manifestHash = await hashManifest(manifest);

    let stored = new Map<string, string | undefined>();
    for (let record of this.storage.documents.list()) stored.set(record.path, record.hash);
    let { needed, unchanged, toDelete } = planUploads(manifest, stored);

    let sessionId = crypto.randomUUID();
    this.storage.transaction(() => {
      // A new plan supersedes any previous one, which is also how abandoned sessions get cleaned up.
      this.#clearStaging();
      this.storage.ingestSession.put({
        sessionId, commit, manifestHash, neededCount: needed.length,
      });
    });

    return { status: "planned", sessionId, needed, unchanged, toDelete: toDelete.length };
  }

  /** Hold uploaded documents until commit, so a partial transfer is never visible to agents. */
  async stageDocuments(sessionId: string, documents: StagedDocument[]): Promise<StageOutcome> {
    let session = this.storage.ingestSession.get();
    if (!session.sessionId || session.sessionId !== sessionId) return { status: "no-session" };

    this.storage.transaction(() => {
      for (let document of documents) this.storage.staging.put(document);
    });

    return {
      status: "staged",
      staged: documents.length,
      remaining: Math.max(0, session.neededCount - this.#stagedCount()),
    };
  }

  /**
   * Apply the publication in one transaction: upsert what was staged, delete what the manifest no
   * longer lists, record the commit, clear staging.
   */
  async commitIngest(sessionId: string, manifest: ManifestEntry[]): Promise<CommitOutcome> {
    let session = this.storage.ingestSession.get();
    if (!session.sessionId || session.sessionId !== sessionId) return { status: "no-session" };

    // Await before the transaction, never inside it.
    if (await hashManifest(manifest) !== session.manifestHash) return { status: "manifest-mismatch" };

    let staged = Array.from(this.storage.staging.list());

    // Cross-check every staged document against the committed manifest. This is the integrity gate:
    // the handler verified each body against its declared hash, and this verifies those hashes are
    // the ones the manifest actually asked for.
    let wanted = new Map(manifest.map(entry => [entry.path, entry.hash]));
    for (let document of staged) {
      if (wanted.get(document.path) !== document.hash) return { status: "manifest-mismatch" };
    }

    let added = 0;
    let updated = 0;
    let deleted = 0;
    // Set inside the transaction if the session was superseded during the await above; read after,
    // still with no await between them, so the check stays inside the atomic section it protects.
    let sessionChanged = false;
    // Set inside the transaction when the manifest does not describe a state this collection can
    // reach, for the same reason: both are decided from storage read within the atomic section.
    let missing = 0;

    this.storage.transaction(() => {
      // Re-check the session's identity here, not just before the transaction: the await on
      // hashManifest() above is a point where a concurrent planIngest+stageDocuments could have
      // discarded this session and staged a different one. Re-reading before the transaction would
      // only narrow that window, not close it; only a check inside the transaction — atomic with the
      // writes it guards — can. If the session moved on, abort without touching storage.
      let current = this.storage.ingestSession.get();
      if (current.sessionId !== sessionId) {
        sessionChanged = true;
        return;
      }

      // One pass over the stored set decides both halves of the apply: what the manifest dropped,
      // and which manifest entries an already-stored document satisfies. Completeness is a question
      // about sets, not counts — a staged document the plan did not ask for (an unchanged file, a
      // retry) would otherwise pay for a document that never arrived, and the collection would
      // record the commit with a file silently missing, never to be asked for again.
      let obsolete: string[] = [];
      let unresolved = new Set(wanted.keys());
      for (let record of this.storage.documents.list()) {
        let want = wanted.get(record.path);
        if (want === undefined) obsolete.push(record.path);
        else if (record.hash === want) unresolved.delete(record.path);
      }
      for (let document of staged) unresolved.delete(document.path);
      // Decided before anything is written, so a refusal leaves the collection untouched.
      if (unresolved.size > 0) {
        missing = unresolved.size;
        return;
      }

      for (let document of staged) {
        if (this.storage.documents.get(document.path)) updated++;
        else added++;
        this.#putDocument(document);
      }
      for (let path of obsolete) {
        this.#deleteDocument(path);
        deleted++;
      }

      let meta = this.getMetadata();
      if (meta.content.source !== "push") throw new Error("Collection is not CI-published.");
      meta.content.commit = session.commit;
      meta.content.lastReceivedAt = new Date();
      meta.documentCount = manifest.length;
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);

      this.#clearStaging();
      this.storage.ingestSession.put({
        sessionId: "", commit: "", manifestHash: "", neededCount: 0,
      });
    });

    if (sessionChanged) return { status: "no-session" };
    if (missing > 0) return { status: "incomplete", missing };

    // The publication is already durably committed above. A summary-refresh failure here (e.g. the
    // public registry's KV write) must not turn a successful publish into a reported failure — CI
    // would see a failed publish for content that is actually live. Log and move on; the next `plan`
    // sees the up-to-date commit and the summary catches up on the next successful propagation.
    await this.#propagate().catch((error) => {
      logger.warn("failed to refresh collection summary after a CI publication", {
        event: "context.collection.ingest.propagate.failed",
        collectionId: this.getMetadata().id,
        error,
      });
    });

    logger.info("applied a CI publication to a context collection", {
      event: "context.collection.ingest.applied",
      collectionId: this.getMetadata().id,
      commit: session.commit,
      added, updated, deleted,
    });

    return {
      status: "applied",
      commit: session.commit,
      added, updated, deleted,
      documentCount: manifest.length,
    };
  }

  // --- Search ---

  /** Linear scan over one collection. Replace with an index if collection size makes it matter. */
  async search(query: string, limit: number = 20): Promise<{ path: string; name: string; description: string; snippet?: string; score: number }[]> {
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();

    let tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return [];

    let results: { path: string; name: string; description: string; snippet?: string; score: number }[] = [];

    for (let record of this.storage.documents.list()) {
      let score = 0;
      let snippet: string | undefined;

      let isText = isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE);
      let nameLower = record.name.toLowerCase();
      let descLower = record.description.toLowerCase();
      let bodyLower = isText ? record.body.toLowerCase() : "";

      for (let token of tokens) {
        if (nameLower.includes(token)) score += 10;
        if (descLower.includes(token)) score += 5;
        let bodyIdx = isText ? bodyLower.indexOf(token) : -1;
        if (bodyIdx >= 0) {
          score += 1;
          if (!snippet) {
            let start = Math.max(0, bodyIdx - 40);
            let end = Math.min(record.body.length, bodyIdx + token.length + 80);
            snippet = (start > 0 ? "..." : "") + record.body.slice(start, end) + (end < record.body.length ? "..." : "");
          }
        }
      }

      if (score > 0) {
        results.push({ path: record.path, name: record.name, description: record.description, snippet, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // --- Deletion ---

  async deleteSelf(): Promise<void> {
    let meta = this.getMetadata();
    let id = meta.id;

    if (id) {
      if (meta.visibility === "public") {
        await this.#registry().removePublic(this.#domain(), id);
      } else {
        await this.#ownerLibrary().removeOwnedCollection(id);
      }
    }

    if (meta.content.source === "git" && this.env.ARTIFACTS) {
      await this.env.ARTIFACTS.delete(id).catch((err) => {
        logger.warn("failed to delete Artifacts repo for context collection", {
          event: "artifacts.repo.delete.failed",
          collectionId: id,
          error: err,
        });
      });
    }

    await this.ctx.storage.deleteAll();
  }

  /** Account revocation clears the whole user-library index separately; don't update it per item. */
  async deleteForRevokedOwner(): Promise<void> {
    let meta = this.getMetadata();
    if (meta.content.source === "git" && meta.id && this.env.ARTIFACTS) {
      await this.env.ARTIFACTS.delete(meta.id).catch((err) => {
        logger.warn("failed to delete Artifacts repo while revoking context collection owner", {
          event: "artifacts.repo.delete.for.revoked.owner.failed",
          collectionId: meta.id,
          error: err,
        });
      });
    }
    await this.ctx.storage.deleteAll();
  }

  // --- Propagation ---

  // Refresh this collection's denormalized summary in its index.
  async #propagate(): Promise<void> {
    let meta = this.getMetadata();
    let summary = metadataToSummary(meta);

    if (meta.visibility === "public") {
      await this.#registry().syncPublic(this.#domain(), summary);
    } else {
      await this.#ownerLibrary().updateOwnedCollection(meta.id, summary);
    }
  }
}
