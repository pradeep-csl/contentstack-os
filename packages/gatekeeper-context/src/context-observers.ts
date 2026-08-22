import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";

/**
 * The non-standard method Context gatekeepers call on their own verifier. The overseer only passes
 * a verifier back to the vendor that minted it, so the gatekeeper may trust this result.
 */
export interface ContextVerifierApi extends GatekeeperUserVerifier {
  hasCollectionAccess(sharingDomain: string, collectionId: string): Promise<boolean>;
}

type ObserverKv = Pick<DurableObjectStorage["kv"], "get" | "put" | "delete" | "list">;

export type ContextObservationCheck = {
  excludeObservers?: string[];
  pendingCollections: string[];
  commit(): void;
};

type ObservedCollectionState = true | "pending" | "observed";

/** Resolves the collections scoped to this facet's own workspace. */
export type ResolveScopedCollections = () => Promise<Set<string>>;

/**
 * Strategy C observer state for the broad Context Library singleton. Collections are the data sets:
 * public collections are domain-wide, each private collection belongs to one account, and a
 * workspace-scoped collection belongs to this facet's workspace.
 *
 * Workspace-scoped collections are accessible to every observer *structurally* — an observer is a
 * collaborator on this workspace by construction — so they are never sent to a verifier. This is a
 * third ground for access alongside "public in the domain" and "privately owned by the observer"
 * (see docs/observers.md §9.2), and it is what lets a workspace share curated knowledge and add
 * collaborators at the same time.
 */
export class ContextObserverTracker {
  constructor(
    private kv: ObserverKv,
    private sharingDomain: string,
    private resolveScoped?: ResolveScopedCollections,
  ) {}

  #scopedPromise?: Promise<Set<string>>;

  // Memoized per tracker instance. A tracker is built per operation, so a later operation sees any
  // revocation that happened in between.
  #scoped(): Promise<Set<string>> {
    return (this.#scopedPromise ??= this.resolveScoped?.() ?? Promise.resolve(new Set()));
  }

  // Collections a verifier must actually be asked about: everything not scoped to this workspace.
  async #needingVerification(collectionIds: string[]): Promise<string[]> {
    if (!this.resolveScoped) return collectionIds;
    let scoped = await this.#scoped();
    return collectionIds.filter(collectionId => !scoped.has(collectionId));
  }

  #observerKey(id: string): string { return `observer:${id}`; }
  #observedCollectionKey(collectionId: string): string {
    return `observedCollection:${collectionId}`;
  }

  #isCollectionObserved(collectionId: string): boolean {
    let state = this.#collectionState(collectionId);
    return state === true || state === "observed";
  }

  #collectionState(collectionId: string): ObservedCollectionState | undefined {
    return this.kv.get<ObservedCollectionState>(this.#observedCollectionKey(collectionId));
  }

  #listTrackedCollections(): string[] {
    let prefix = "observedCollection:";
    return [...this.kv.list<ObservedCollectionState>({ prefix })]
        .map(([key]) => key.slice(prefix.length));
  }

  *#listObservers(): IterableIterator<[string, Fetcher<ContextVerifierApi>]> {
    let prefix = "observer:";
    for (let [key, verifier] of this.kv.list<Fetcher<ContextVerifierApi>>({ prefix })) {
      yield [key.slice(prefix.length), verifier];
    }
  }

  async addObserver(id: string, verifier: Fetcher<ContextVerifierApi>): Promise<void> {
    let checked = new Set<string>();
    while (true) {
      let tracked = this.#listTrackedCollections()
          .filter(collectionId => !checked.has(collectionId));
      // Nothing observed yet: admit without resolving scope. Keeps the empty case free.
      if (tracked.length === 0) {
        this.kv.put(this.#observerKey(id), verifier);
        return;
      }
      let collections = await this.#needingVerification(tracked);
      if (collections.length === 0) {
        this.kv.put(this.#observerKey(id), verifier);
        return;
      }
      let access = await Promise.all(collections.map(
        collectionId => verifier.hasCollectionAccess(this.sharingDomain, collectionId),
      ));
      if (access.some(hasAccess => !hasAccess)) {
        throw new Error(
          "This workspace has read a Context collection that this collaborator cannot access — " +
          "either a private collection of another user, or one no longer shared with this " +
          "workspace. Re-sharing that collection with this workspace restores collaborator access.",
        );
      }
      for (let collectionId of collections) checked.add(collectionId);
    }
  }

  removeObserver(id: string): void {
    this.kv.delete(this.#observerKey(id));
  }

  async prepareObservation(collectionIds: string[]): Promise<ContextObservationCheck> {
    let pendingCollections = [...new Set(collectionIds)]
        .filter(collectionId => !this.#isCollectionObserved(collectionId));
    if (pendingCollections.length === 0) return { pendingCollections, commit() {} };

    for (let collectionId of pendingCollections) {
      if (this.#collectionState(collectionId) === undefined) {
        this.kv.put(this.#observedCollectionKey(collectionId), "pending");
      }
    }

    let observers = [...this.#listObservers()];
    // No observers (the common single-user case) means nothing to exclude and no scope to resolve.
    if (observers.length === 0) {
      return {
        pendingCollections,
        commit: () => this.commitObservation(pendingCollections),
      };
    }
    let toVerify = await this.#needingVerification(pendingCollections);
    let observerAccess = await Promise.all(observers.map(async ([id, verifier]) => {
      let access = await Promise.all(toVerify.map(
        collectionId => verifier.hasCollectionAccess(this.sharingDomain, collectionId),
      ));
      return [id, access.every(hasAccess => hasAccess)] as const;
    }));
    let excluded = observerAccess.filter(([, hasAccess]) => !hasAccess).map(([id]) => id);
    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      pendingCollections,
      commit: () => this.commitObservation(pendingCollections),
    };
  }

  commitObservation(pendingCollections: string[]): void {
    for (let collectionId of pendingCollections) {
      this.kv.put(this.#observedCollectionKey(collectionId), "observed");
    }
  }
}
