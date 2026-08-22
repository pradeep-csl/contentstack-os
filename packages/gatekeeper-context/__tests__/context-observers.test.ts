import { describe, expect, it } from "vitest";
import {
  ContextObserverTracker, type ContextVerifierApi,
} from "../src/context-observers.js";

type TrackerKv = ConstructorParameters<typeof ContextObserverTracker>[0];

function makeKv(): TrackerKv {
  let map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => void map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
}

function verifier(allowed: string[]) {
  let calls: Array<{ sharingDomain: string; collectionId: string }> = [];
  let api = {
    async hasCollectionAccess(sharingDomain: string, collectionId: string) {
      calls.push({ sharingDomain, collectionId });
      return allowed.includes(collectionId);
    },
  } as unknown as Fetcher<ContextVerifierApi>;
  return { api, calls };
}

async function observe(tracker: ContextObserverTracker, collectionIds: string[]) {
  let check = await tracker.prepareObservation(collectionIds);
  check.commit();
  return check.excludeObservers;
}

describe("ContextObserverTracker", () => {
  it("checks every past collection before storing an observer", async () => {
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example");
    await observe(tracker, ["public", "private"]);
    let denied = verifier(["private"]);

    await expect(tracker.addObserver("observer", denied.api)).rejects.toThrow(
      /has read a Context collection that this collaborator cannot access/,
    );
    expect(denied.calls).toEqual([
      { sharingDomain: "workshop.example", collectionId: "public" },
      { sharingDomain: "workshop.example", collectionId: "private" },
    ]);

    await observe(tracker, ["later"]);
    expect(denied.calls).toHaveLength(2);
  });

  it("excludes observers from new collections and removes them idempotently", async () => {
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example");
    let allowed = verifier(["first", "second", "third"]);
    let limited = verifier(["first"]);
    await tracker.addObserver("allowed", allowed.api);
    await tracker.addObserver("limited", limited.api);

    expect(await observe(tracker, ["first"])).toBeUndefined();
    expect(await observe(tracker, ["second", "second"])).toEqual(["limited"]);
    expect(await observe(tracker, ["second"])).toBeUndefined();

    tracker.removeObserver("limited");
    tracker.removeObserver("limited");
    expect(await observe(tracker, ["third"])).toBeUndefined();
    expect(limited.calls.map(call => call.collectionId)).toEqual(["first", "second"]);
  });

  it("keeps blocked collections pending and rechecks them on retry", async () => {
    let kv = makeKv();
    let tracker = new ContextObserverTracker(kv, "workshop.example");
    let limited = verifier([]);
    await tracker.addObserver("limited", limited.api);

    let first = await tracker.prepareObservation(["private"]);
    expect(first.excludeObservers).toEqual(["limited"]);
    expect(kv.get("observedCollection:private")).toBe("pending");

    let retry = await tracker.prepareObservation(["private"]);
    expect(retry.excludeObservers).toEqual(["limited"]);
    tracker.removeObserver("limited");
    let allowedRetry = await tracker.prepareObservation(["private"]);
    expect(allowedRetry.excludeObservers).toBeUndefined();
    allowedRetry.commit();
    expect(kv.get("observedCollection:private")).toBe("observed");
    expect(limited.calls.map(call => call.collectionId)).toEqual(["private", "private"]);
  });

  it("checks pending collections when admitting a concurrent observer", async () => {
    let kv = makeKv();
    let tracker = new ContextObserverTracker(kv, "workshop.example");
    let release!: () => void;
    let waiting = new Promise<void>(resolve => { release = resolve; });
    let current = {
      async hasCollectionAccess() { await waiting; return true; },
    } as unknown as Fetcher<ContextVerifierApi>;
    await tracker.addObserver("current", current);

    let preparing = tracker.prepareObservation(["new"]);
    expect(kv.get("observedCollection:new")).toBe("pending");
    let denied = verifier([]);
    await expect(tracker.addObserver("new", denied.api)).rejects.toThrow(
      /has read a Context collection that this collaborator cannot access/,
    );
    release();
    (await preparing).commit();
    expect(denied.calls.map(call => call.collectionId)).toEqual(["new"]);
  });

  it("rechecks collections added while observer admission is awaiting", async () => {
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example");
    await observe(tracker, ["old"]);
    let release!: () => void;
    let waiting = new Promise<void>(resolve => { release = resolve; });
    let calls: string[] = [];
    let candidate = {
      async hasCollectionAccess(_domain: string, collectionId: string) {
        calls.push(collectionId);
        if (collectionId === "old") await waiting;
        return collectionId === "old";
      },
    } as unknown as Fetcher<ContextVerifierApi>;

    let admission = tracker.addObserver("candidate", candidate);
    await tracker.prepareObservation(["new"]);
    release();
    await expect(admission).rejects.toThrow(
      /has read a Context collection that this collaborator cannot access/,
    );
    expect(calls).toEqual(["old", "new"]);
  });

  it("handles concurrent mixed collection attempts and legacy markers", async () => {
    let kv = makeKv();
    kv.put("observedCollection:legacy", true);
    let tracker = new ContextObserverTracker(kv, "workshop.example");
    let limited = verifier(["legacy"]);
    await tracker.addObserver("limited", limited.api);

    let first = tracker.prepareObservation(["pending"]);
    let concurrent = tracker.prepareObservation(["pending"]);
    expect((await first).excludeObservers).toEqual(["limited"]);
    expect((await concurrent).excludeObservers).toEqual(["limited"]);

    let mixed = await tracker.prepareObservation(["legacy", "pending", "new", "new"]);
    expect(mixed.pendingCollections).toEqual(["pending", "new"]);
    expect(mixed.excludeObservers).toEqual(["limited"]);
    mixed.commit();
    expect((await tracker.prepareObservation(["legacy", "pending", "new"]))
      .pendingCollections).toEqual([]);
  });

  it("never asks a verifier about a collection scoped to this workspace", async () => {
    let scoped = new Set(["project"]);
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example", async () => scoped);
    let denied = verifier([]);
    await tracker.addObserver("collaborator", denied.api);

    // A scoped collection is accessible to every observer of this facet by construction: an
    // observer *is* a collaborator on this workspace.
    expect(await observe(tracker, ["project"])).toBeUndefined();
    expect(denied.calls).toEqual([]);
  });

  it("admits an observer even when a scoped collection was already read", async () => {
    let scoped = new Set(["project"]);
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example", async () => scoped);
    await observe(tracker, ["project"]);

    let denied = verifier([]);
    await expect(tracker.addObserver("collaborator", denied.api)).resolves.toBeUndefined();
    expect(denied.calls).toEqual([]);
  });

  it("consults the verifier again once the scope is revoked, and stops when it is restored", async () => {
    let scoped = new Set(["project"]);
    let kv = makeKv();
    let tracker = new ContextObserverTracker(kv, "workshop.example", async () => scoped);
    await observe(tracker, ["project"]);

    // Revoked: the workspace's log still holds the data, so a new collaborator must be checked.
    scoped.delete("project");
    let denied = verifier([]);
    await expect(tracker.addObserver("collaborator", denied.api)).rejects.toThrow(
      /no longer shared with this workspace/,
    );
    expect(denied.calls.map(call => call.collectionId)).toEqual(["project"]);

    // Re-scoped: admission works again. This is the documented remedy.
    scoped.add("project");
    let second = verifier([]);
    await expect(tracker.addObserver("collaborator", second.api)).resolves.toBeUndefined();
    expect(second.calls).toEqual([]);
  });

  it("re-verifies observers once a scope the observation rested on is revoked", async () => {
    // One tracker per operation, as in production: a tracker memoizes the scoped set, so a later
    // operation is what sees a revocation.
    let scoped = new Set(["project"]);
    let kv = makeKv();
    let resolutions = 0;
    let trackerFor = () => new ContextObserverTracker(kv, "workshop.example", async () => {
      resolutions++;
      return scoped;
    });
    let collaborator = verifier([]);
    await trackerFor().addObserver("collaborator", collaborator.api);

    // Read while scoped: admitted with no verifier query, and remembered as resting on the scope.
    expect(await observe(trackerFor(), ["project"])).toBeUndefined();
    expect(kv.get("observedCollection:project")).toBe("observed-scoped");
    expect(collaborator.calls).toEqual([]);

    // Revoked. The collection is private again, so its owner's library re-enables it in every
    // workspace — including this one. The collaborator must stop seeing what it adds from here on.
    scoped.delete("project");
    let check = await trackerFor().prepareObservation(["project"]);
    expect(check.excludeObservers).toEqual(["collaborator"]);
    expect(collaborator.calls.map(call => call.collectionId)).toEqual(["project"]);
    check.commit();
    // The verifier has now spoken for it, so its ground is ownership and the recheck stops.
    expect(kv.get("observedCollection:project")).toBe("observed");
    // Two resolutions: the two reads. The admission needed none — nothing was observed yet.
    expect(resolutions).toBe(2);

    let settled = await trackerFor().prepareObservation(["project"]);
    expect(settled.excludeObservers).toBeUndefined();
    expect(collaborator.calls).toHaveLength(1);
    // No third resolution: an observation on a monotone ground costs the read path nothing again.
    expect(resolutions).toBe(2);
  });

  it("keeps skipping the verifier while the scope stands, however often it is read", async () => {
    let kv = makeKv();
    let trackerFor = () => new ContextObserverTracker(
      kv, "workshop.example", async () => new Set(["project"]));
    let collaborator = verifier([]);
    await trackerFor().addObserver("collaborator", collaborator.api);

    for (let i = 0; i < 3; i++) {
      expect(await observe(trackerFor(), ["project"])).toBeUndefined();
      expect(kv.get("observedCollection:project")).toBe("observed-scoped");
    }
    // Still scoped, so still nobody to ask. Rechecking costs one scoped-set resolution, which in
    // production is a projection of the enabled map the session already resolved, not a new read.
    expect(collaborator.calls).toEqual([]);
  });

  it("records the scope as the ground when an observer is admitted after the read", async () => {
    // The read comes first here, so it is the admission — not the observation — that rests on the
    // scope. Without recording it there, a later revoke would leave this observer reading on.
    let scoped = new Set(["project"]);
    let kv = makeKv();
    let trackerFor = () => new ContextObserverTracker(kv, "workshop.example", async () => scoped);
    await observe(trackerFor(), ["project"]);
    expect(kv.get("observedCollection:project")).toBe("observed");

    let collaborator = verifier([]);
    await trackerFor().addObserver("collaborator", collaborator.api);
    expect(kv.get("observedCollection:project")).toBe("observed-scoped");

    scoped.delete("project");
    expect(await observe(trackerFor(), ["project"])).toEqual(["collaborator"]);
  });

  it("resolves no scope when there is nothing left to check", async () => {
    let kv = makeKv();
    let resolutions = 0;
    let trackerFor = () => new ContextObserverTracker(kv, "workshop.example", async () => {
      resolutions++;
      return new Set<string>();
    });
    // No observers: nothing to exclude, so neither the verifier nor the scoped set is consulted.
    await observe(trackerFor(), ["shared"]);
    expect(resolutions).toBe(0);

    // Observed and unscoped: the fast path stays fast for every later read of it.
    await trackerFor().addObserver("collaborator", verifier(["shared"]).api);
    let repeat = await trackerFor().prepareObservation(["shared"]);
    expect(repeat.pendingCollections).toEqual([]);
    expect(repeat.excludeObservers).toBeUndefined();
    expect(resolutions).toBe(1);
  });

  it("still checks unscoped collections when a scope resolver is present", async () => {
    let tracker = new ContextObserverTracker(
      makeKv(), "workshop.example", async () => new Set(["project"]));
    await observe(tracker, ["project", "shared"]);

    let limited = verifier([]);
    await expect(tracker.addObserver("collaborator", limited.api)).rejects.toThrow();
    expect(limited.calls.map(call => call.collectionId)).toEqual(["shared"]);
  });
});
