import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { VENDOR_ID } from "./context-types.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

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

/**
 * How an observed collection's access was grounded. `true` is a legacy marker equivalent to
 * `"observed"`. `"observed-scoped"` records the one *revocable* ground — the collection was scoped
 * to this workspace, so no verifier was consulted — and is therefore the one state a later
 * observation must recheck. The other grounds (owned by the observer, public in the domain) are
 * monotone, which is what lets their keys stay sticky.
 */
type ObservedCollectionState = true | "pending" | "observed" | "observed-scoped";

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
 *
 * It is also the only *revocable* ground, so which ground an observation rested on is recorded with
 * it: a collection observed because it was scoped here is re-verified once it stops being scoped,
 * rather than staying observed on the strength of a scope that is gone.
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
    return state === true || state === "observed" || state === "observed-scoped";
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
      // Whatever the verifier is spared is spared because it is scoped here, and that is the ground
      // this admission rests on. Record it, so the observation stops being trusted the moment the
      // scope is revoked — the read that keyed it may well have predated any observer.
      let restingOnScope = tracked.filter(collectionId => !collections.includes(collectionId));
      if (collections.length === 0) {
        this.#recordScopedGround(restingOnScope);
        this.kv.put(this.#observerKey(id), verifier);
        return;
      }
      let access = await Promise.all(collections.map(
        collectionId => verifier.hasCollectionAccess(this.sharingDomain, collectionId),
      ));
      let denied = collections.filter((_, index) => !access[index]);
      if (denied.length > 0) {
        // The host logs the rejection but cannot know which collection caused it, and a revoked
        // scope makes this denial an ordinary part of use (§7.2). Ids only — never titles,
        // descriptions or content — and an id grants nothing on its own, since every read of a
        // collection is ownership- or scope-checked.
        logger.warn("collaborator cannot access a collection this workspace has read", {
          event: "observer.collection.access.denied",
          collectionIds: denied.join(","),
        });
        throw new Error(
          "This workspace has read a Context collection that this collaborator cannot access — " +
          "either a private collection of another user, or one no longer shared with this " +
          "workspace. Re-sharing that collection with this workspace restores collaborator access.",
        );
      }
      this.#recordScopedGround(restingOnScope);
      for (let collectionId of collections) checked.add(collectionId);
    }
  }

  // Re-keys already-observed collections whose access now rests on this workspace's scope. Only
  // reached where the scoped set is already resolved, so it costs the read path nothing.
  #recordScopedGround(scopedCollectionIds: string[]): void {
    for (let collectionId of scopedCollectionIds) {
      if (this.#isCollectionObserved(collectionId)) {
        this.kv.put(this.#observedCollectionKey(collectionId), "observed-scoped");
      }
    }
  }

  removeObserver(id: string): void {
    this.kv.delete(this.#observerKey(id));
  }

  async prepareObservation(collectionIds: string[]): Promise<ContextObservationCheck> {
    let requested = [...new Set(collectionIds)];
    let pendingCollections = requested
        .filter(collectionId => !this.#isCollectionObserved(collectionId));
    // Observations admitted on the strength of a scope are the one kind that can go stale, so they
    // are rechecked on every read until their ground stops being the scope.
    let scopedObserved = requested
        .filter(collectionId => this.#collectionState(collectionId) === "observed-scoped");
    if (pendingCollections.length === 0 && scopedObserved.length === 0) {
      return { pendingCollections, commit() {} };
    }

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
    let scoped = await this.#scoped();
    let unscoped = (ids: string[]) => ids.filter(collectionId => !scoped.has(collectionId));
    // Everything the verifier must speak to: what is newly in play, plus what was admitted for a
    // scope it no longer has.
    let toVerify = [...unscoped(pendingCollections), ...unscoped(scopedObserved)];
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
      commit: () => this.commitObservation([...pendingCollections, ...scopedObserved], scoped),
    };
  }

  /**
   * Records each observation's ground: a collection in the scoped set keeps being rechecked, while
   * one the verifier has now spoken for becomes plainly observed, because from here on its access
   * rests on ownership or on being public. An absent scoped set means none was resolved, which is
   * only the case when there was no observer to protect.
   */
  commitObservation(pendingCollections: string[], scoped?: Set<string>): void {
    for (let collectionId of pendingCollections) {
      this.kv.put(this.#observedCollectionKey(collectionId),
          scoped?.has(collectionId) ? "observed-scoped" : "observed");
    }
  }
}
