# Global Knowledge Layer from GitHub Repositories

Let department-owned GitHub repositories publish their content into the Context Library over an
authenticated HTTP protocol, so every Workshop agent can search and read them.

## Problem

Departments author knowledge in dedicated GitHub repositories (`company/sales-wiki`,
`company/engineering-wiki`, ...) using a normal `edit → commit → pull request → merge` workflow.
Agents cannot reach any of it.

The deployment wants **global** knowledge, skills and instructions assembled from several
repositories. Per-department restriction is explicitly out of scope for this phase.

Expected scale: **10–15 MB of content in total**, across roughly a dozen repositories, growing.

## What already exists

The Context Library gatekeeper (`packages/gatekeeper-context`) is already the knowledge layer:

- It is auto-provisioned and always available. Its account provides an ambient singleton giving every
  workspace `search()` / `list()` / `read()` over collections, with each read recorded as an agent
  observation.
- Public collections are admin-created and auto-enabled for every user in the sharing domain —
  exactly the "global knowledge" requirement.
- A `SKILL.md` file inside a collection becomes a slash command and an Agent Catalog entry
  (`agent-skill.ts`), so repositories can ship agent skills as committed files.
- Documents already carry auto-extracted descriptions (`description-extractors.ts`) and content types
  derived from their path (`context-types.ts`).

### Why not the existing git-mirror source

A collection can already have `content.source === "git"`, but that path mirrors a **workshop-hosted
Artifacts repository** — `context-collection.ts` creates the repo itself and `artifact-sync.ts`
authenticates with a token minted from the `ARTIFACTS` binding.

That binding is unavailable. Per `scripts/release/manifest-lib.mjs`, it is *"closed-beta and cannot be
provisioned in arbitrary user accounts; it is dropped from customer manifests"*, and a golden-file
test asserts the shipped context worker carries no `ARTIFACTS` binding. This deployment cannot get
access, so the git-mirror source is not an option.

### Why not pull from GitHub

Extending the gatekeeper to clone `github.com` directly was considered and rejected: it requires
storing a GitHub App private key, adds outbound egress and SSRF surface to a Worker that currently
makes no external calls, needs the `global_fetch_strictly_public` compatibility flag, and consumes a
GitHub API budget. The push design needs none of that, and the deployment holds no GitHub credential
at all.

### Why not a single POST of the whole repository

The first version of this design had CI post the entire document set in one request. It was rejected
once the real scale became clear, for two independent reasons:

- **Request size.** At 10–15 MB the Worker would hold the body string, its parsed form and the
  normalized array at once — roughly 60 MB+ of a 128 MB budget. Compression shrinks the wire but not
  the memory. (The Durable Object RPC ceiling turned out **not** to be the binding constraint: it was
  measured at 32 MiB, so a 15 MB payload would have crossed it fine. Worker memory and the write
  amplification below are the real reasons.)
- **Write amplification.** Whole-set replacement rewrites every row on every merge. Fixing one typo in
  a 3,000-file wiki costs ~6,000 row operations. That scales with repository size rather than with
  what changed, and it is pure waste.

The manifest protocol below fixes both, and it does not need revisiting when a wiki doubles.

## Decisions

| Question | Decision |
|---|---|
| Content source | Dedicated GitHub markdown repositories with PR review, one per department |
| Ingestion | CI publishes over a three-step manifest protocol on `gatekeeper-context` |
| Transfer unit | Only documents whose content hash changed; bounded batches |
| Access model | Global — public collections readable by every user, no per-user filtering |
| Credentials | The deployment holds none; CI holds a per-collection ingestion token |
| Skills | `SKILL.md` files in the published content — already supported, no new code |
| Instructions | Published as documents and skills, **not** wired into the agent system prompt |

## Architecture

```
company/sales-wiki ──(merge to main → GitHub Action)
        │
        │  1. plan    { commit, manifest: [{path, hash}] }  ->  { sessionId, needed: [...] }
        │  2. upload  { sessionId, documents: [...] }        ->  repeat until needed is exhausted
        │  3. commit  { sessionId, manifest }                ->  { applied, added, updated, deleted }
        ▼
gatekeeper-context worker -> ContextCollectionDurableObject
        │                     (verify token -> stage -> apply atomically)
        ▼
every workspace's agent — search() / list() / read(), recorded as observations
```

One public collection per source repository, with a new `push` content source.

The manifest is the **full desired state**: anything absent from it is deleted at commit. That is what
keeps deletion exact and drift structurally impossible, without transferring unchanged content.

### Why the pieces already fit

- **The route exists.** The router forwards `/gatekeeper/<name>/*` to the bound gatekeeper worker,
  unmodified — it calls `fetch(req)` with no prefix stripping (`router/src/index.ts`).
  `gatekeeper-context` already exports a default fetch handler; it is currently a stub.
- **The apply step exists.** `#replaceArtifactDocuments` already clears, writes, rebuilds the skill
  index and records a commit inside one `storage.transaction()`. Commit reuses that transactional
  shape with an upsert-and-delete body instead of a wholesale replace.
- **The token pattern exists.** Workshop share links store only an HMAC-SHA-256 hash of a random
  128-bit key, never the key (`docs/sharing.md`), so a storage leak yields nothing usable.

## Components

### a. The ingestion protocol

Three routes under `/gatekeeper/context/ingest/<sharingDomain>/<collectionId>/`, each authenticated
with the same bearer token.

**`POST .../plan`**

```json
{ "commit": "a1b2c3",
  "manifest": [ { "path": "pricing/discounts.md", "hash": "<sha256-hex>" } ],
  "allowEmpty": false }
```

The collection compares the manifest against the hash stored on each document and replies with only
what it lacks:

```json
{ "sessionId": "...", "needed": ["pricing/discounts.md"], "unchanged": 812, "toDelete": 3 }
```

If `commit` already matches the stored commit, the reply is `{ "status": "unchanged" }` and no session
is opened — the cheap idempotency the old design had, preserved.

**`POST .../upload`** — `{ sessionId, documents: [{ path, body, encoding?, hash }] }`, repeated until
`needed` is exhausted. Each body is hashed on arrival and must match the manifest hash, which gives
integrity checking for free. Documents land in staging, not in the collection.

**`POST .../commit`** — `{ sessionId, manifest }`. The manifest is re-sent rather than stored: it is
~200 KB for a 3,000-file wiki, cheap to transmit twice and free to keep, whereas persisting it would
reintroduce exactly the per-file write amplification the protocol exists to avoid. The collection
verifies the manifest still hashes to what `plan` recorded, then in **one transaction** upserts the
staged documents, deletes every stored document absent from the manifest, records the commit, and
clears staging.

`sharingDomain` appears in the path because it is not otherwise knowable: it reaches the gatekeeper
through `ctx.props` on the `WorkerEntrypoint`, and a plain fetch handler has no props, while every
Durable Object is addressed as `domainName(domain, id)`. Carrying it in the URL is safe — `domain.ts`
documents the domain as a namespacing device explicitly *"not a boundary against malicious peer
configs"*. Authority comes from the token, never the path.

### b. Ingestion tokens

Stored in the collection DO: a random 128-bit token, persisted only as an HMAC-SHA-256 hash, with an
id, a creation time and a one-year TTL (matching `GIT_TOKEN_TTL_SECONDS`, so rotation is the same
story admins already have). Minted, listed and revoked through `ContextApi` alongside the existing
git-token methods.

Every route verifies the token **before reading its request body**. The reverse order would let anyone
with a junk token force a multi-megabyte read and parse against a public endpoint.

Minting also purges expired rows. Revocation deletes, but expiry alone never did.

### c. `push` collection source and document hashes

`ContextCollectionContent` gains a third variant:

```ts
| { source: "push"; commit?: string; lastReceivedAt?: Date }
```

`ContextRecord` gains `hash?: string` — the SHA-256 of the document's raw bytes, which is what makes
delta detection possible. A record without a hash (any document written before this change) is treated
as needing upload, so the first publish after deployment is a full one.

Staging lives in the same DO: a `staging` collection keyed by path, plus a small session singleton
holding `{ sessionId, commit, manifestHash, neededCount, allowEmpty }`. Only one session exists at a
time; a new `plan` discards any previous one, which is also how abandoned sessions get cleaned up.

Consequences: no background refresh (nothing to poll), content read-only in the UI as with git
collections, and `deleteSelf` needs no Artifacts cleanup.

### d. Server-side normalization

CI sends raw file content and stays dumb. The worker derives `contentType` from the path
(`contentTypeFromPath`), decodes `encoding: "base64"` bodies, verifies the hash, and extracts each
description with the existing `extractDescription`. Keeping this server-side means published documents
are indistinguishable from any other source, and parsing rules can evolve without changing every
repository's workflow.

### e. CI workflow

A workflow in each repository, triggered on `push` to the protected branch, runs a committed script
that hashes the tracked files, calls `plan`, uploads only what is asked for in batches under the
request cap, and calls `commit`.

The trigger is a push to the protected branch, so in normal operation only content that survived PR
review becomes agent knowledge. Two honest qualifications: nothing enforces this on our side — it is
inherited from the repository's branch protection — and a manually dispatched run would publish
whatever ref it was pointed at. The workflow therefore omits `workflow_dispatch`; to re-publish, re-run
the job for a merged commit.

CI selects files by an explicit **include** list rather than an exclude list. An exclude list has to
anticipate everything, so `LICENSE`, `CODEOWNERS`, lockfiles and CI config all end up as "knowledge"
an agent may surface.

### f. Instructions (deliberately limited)

Global "instructions" are published as ordinary documents and skills. They are **not** wired into
`AdminConfig.instanceInstructions`, which is appended to the agent's system prompt. Sourcing that from
a repository would let anyone with merge rights rewrite the agent's instructions deployment-wide, with
no review step on our side. If it is wanted later it must pass through explicit admin review in
`/admin`, never a sync job.

## Cost model

Durable Objects bill for requests, duration, and (SQLite-backed) rows read and written. Rows written
dominate for ingestion, and the protocol is shaped around that.

| Operation | Whole-set POST | Manifest + delta |
|---|---|---|
| One-word fix in a 3,000-file wiki | ~6,000 row writes | 2 row writes (stage, then apply) |
| Adding one page | ~6,000 row writes | 2 row writes |
| First publish of a 3,000-file wiki | ~6,000 row writes | ~6,000 row writes (unavoidable) |
| 15 repos x 10 merges/day | ~$27/month | cents |

The runaway-cost failure modes on Durable Objects are alarms that reschedule themselves, WebSockets
held open without hibernation, objects that call themselves recursively, and unbounded object creation
from untrusted input. This design has none of the first three: no alarms, no sockets, no self-calls,
and every request is short-lived.

One contention point is worth naming, because it is not obvious from the per-collection design: every
public collection in a sharing domain shares **one KV key** for the domain's public-collections
snapshot (`publicCollectionsKvKey`). Cloudflare KV permits roughly one write per second to a single
key, so a naive rewrite-on-every-publish would have every publication in the domain contend on it —
worse as CI jobs finish together or during bulk onboarding.

**Fixed.** `LibraryRegistryDurableObject.syncPublic` rewrites the snapshot only when a field its
consumers actually read for identity — `title`, `description`, `icon`, `visibility` — has changed;
`documentCount` and `lastUpdated` no longer trigger a write. A plain publish only changes those two
fields, so publishing no longer touches this KV key at all. Membership changes still go through
`addPublic`/`removePublic`, which write unconditionally. The trade-off: the snapshot's `documentCount`
and `lastUpdated` go stale between identity edits. That is acceptable because nothing reads the
snapshot's `documentCount` (`getEnabledCollections` reads only `id`; `loadEnabledContextCollections`
reads `id`/`title`/`description`/`icon`/`lastUpdated` but not `documentCount`; agent listings fetch
`documentCount` fresh from each collection's own Durable Object, never from the snapshot), and
`lastUpdated` here is presentation recency only. The hot spot predates this design, which no longer
adds a frequent writer to it.

The fourth runaway mode applied and is closed deliberately: resolving a collection instantiates a
Durable Object for **whatever path was requested**, so the public endpoint is bounded by a
`ratelimits` binding keyed on the collection path. That rate limiter is the single most important cost control in the design —
without it, an unauthenticated caller can drive request and duration billing at will.

## Retrieval cost (known, measured separately)

`search()` iterates every document and lowercases each body (`context-collection.ts`), so a search
loads an entire collection into memory and allocates a doubled copy. The code already flags this
("Replace with an index if collection size makes it matter"). It has not mattered because collections
were hand-authored and tiny; publishing 10–15 MB is what makes it matter.

In dollars this is small — duration and rows-read are cheap. In **latency** it is not: with global
collections, every agent question fans out across all of them and each loads its full contents.

**Measured 2026-08-18, and it does not currently need fixing.** Against a synthetic corpus at the
stated target scale — 12 public collections, 340 markdown pages each, ~1.25 MB per collection, ~15 MB
in total — a single-collection `search()` took **2 ms** and a whole-library fan-out across all twelve
took **16 ms**. The linear scan's CPU cost is therefore negligible at this size, roughly two orders of
magnitude below the point where it would be felt.

Two caveats on that number. It was taken in the local Workers test pool, so it measures the scan
itself and excludes what production adds: twelve Durable Object round trips, cold starts, and real
storage I/O — which will dominate the total and are unaffected by any indexing work. And it scales
linearly with content, so a tenfold growth in the corpus would put the scan in the low hundreds of
milliseconds and make it worth revisiting.

If it ever does need fixing, the change is to split bodies from searchable metadata so `search()` stops
loading every body — independent of ingestion, and able to land on its own.

## Data flow

1. A department merges a PR to the protected branch.
2. CI hashes every included file and calls `plan` with the commit and the manifest.
3. The collection returns the paths it lacks. If the commit is unchanged, it returns `unchanged` and CI
   stops.
4. CI uploads only those documents, in batches under the per-request cap. Each body's hash is verified
   on arrival and staged.
5. CI calls `commit`. In one transaction the collection upserts staged documents, deletes everything
   absent from the manifest, records the commit and clears staging.
6. Agents see the new content on their next search. No polling, no staleness window.

Concurrent publishes to the same collection resolve last-write-wins: a second `plan` discards the first
session, and the commit transaction is atomic, so no publish is ever partially applied.

## Security

- **Authentication happens before any body is read**, on all three routes. The token is per-collection
  and compared by hash; a miss is 401 with no distinction between wrong token and unknown collection.
- **Authorization** is implied by scope: a token can publish to exactly one collection.
- **A leaked token lets someone replace that collection's content**, and agents read the result.
  Mitigations: per-collection scope, TTL, immediate revocation, and logged events. Token custody is
  what actually protects a global collection.
- **Rate limiting is required before exposure**, for the reason in the cost model above.
- **Limits**, enforced before anything is written: a 5 MB request body, 5,000 manifest entries, and the
  existing 1.4 MB `MAX_DOCUMENT_BODY_BYTES` per document. Unlike the git path, an oversized document is
  a hard error naming the file rather than a silent skip: commit requires every planned path, so a
  skipped document would fail the publication later with a far less useful message.

  **Measured 2026-08-18:** the Durable Object RPC ceiling is 32 MiB, enforced by the runtime with an
  explicit error ("Serialized RPC arguments or return values are limited to 32MiB"). Arguments of 1,
  5, 10 and 20 MB all crossed successfully; 40 MB failed. The 5 MB batch cap therefore has roughly six
  times the headroom it needs, and the binding constraint is Worker memory rather than RPC size.
- **Hash verification on upload** means a body that does not match its manifest entry is rejected, so a
  truncated or corrupted transfer cannot be committed as good content.
- **An empty manifest is rejected** unless `allowEmpty: true`. A full-state publish with nothing in it
  means "delete everything" — valid, and far more often a broken build than an intention.
- **Replay is harmless**: `plan` is idempotent on the commit, uploads are hash-checked, and a repeated
  commit finds no session.
- **Logging** records `collectionId`, `commit`, counts and outcome — never content, never the token or
  its hash. Rejected requests are logged at `warn`.

## Failure handling

| Failure | Behaviour |
|---|---|
| Bad or revoked token | 401 on any route. The Action fails in the department's own repository, visible to the people who own the content. |
| Upload body fails its hash | 400; that document is not staged. Commit then fails as incomplete, so nothing is applied. |
| Commit with uploads outstanding | 409; the collection keeps its previous content. |
| Commit whose manifest does not match the session | 409; guards against a manifest changing between plan and commit. |
| Empty manifest without `allowEmpty` | 422, nothing written. |
| Oversized single document | 400 naming the file; nothing is staged, so the publication fails cleanly. |
| Request body over the cap | 413 before any write. |
| Rate limit exceeded | 429 before the collection is consulted. |
| Abandoned session | Superseded by the next `plan`, which discards it. |
| Partial write | Not possible — commit is one transaction. |
| Public-collections snapshot write fails after commit | **Fixed.** `commitIngest` still awaits `#propagate()` in the same position — after the commit transaction, so the happy path still refreshes the snapshot before returning — but now catches a rejection and logs it at `warn` instead of letting it fail the call. The content is already committed by that point, so a refresh failure (e.g. a KV outage) can no longer turn a successful publish into a reported failure. The other `#propagate()` callers (`putContextDocument`, `deleteContextDocument`, `moveContextDocument`) are interactive web edits and are unchanged: failing loudly there is still correct. |

## Constraints

- The include list decides what becomes knowledge. Widen it deliberately.
- Base64 inflates binary assets by roughly a third. Markdown-dominated repositories are unaffected.
- Search is a linear scan per collection — see "Retrieval cost" above.
- Search fans out across enabled collections eight at a time (`MAX_COLLECTION_FANOUT`) — a concurrency
  cap, not a truncation.
- Per-document provenance is not surfaced: search and read results carry no repository, branch or
  commit, so agents cannot cite a GitHub URL. The first thing to add if citations matter.

## Designed for extension

Phase 1 ships global knowledge only, but three decisions keep the later scoping phases cheap.

**Ingestion must not depend on visibility.** A token authorizes publishing to exactly one collection,
whatever its visibility. Nothing in the routes, the token check or the `push` source may assume
`public`, or phase 2 and 3 collections could not use the same pipeline.

**Collection-set resolution belongs behind one seam.** `LibraryReadSession` currently computes its
enabled set by calling `userLib().getEnabledCollections()` directly. Phase 2 needs a session pinned to
a single collection, so that resolution is injected instead. Everything downstream already works on a
collection list, including the skill index.

**Readability is encoded in three places, not one.** Any future visibility must be taught to all of
them:

1. `UserLibraryDurableObject.getEnabledCollections()` — what an agent's session may reach.
2. `ContextApiImpl.#assertCanRead()` / `#ownsPrivate()` — the management API.
3. `ContextVerifier.hasCollectionAccess()` — whether someone opening a *shared gadget* may
   independently read a collection that gadget observed.

The third is the one to remember: it is reached through gadget sharing rather than the read path.

## Risk

Publishing a repository makes it readable by every agent user in the deployment. Onboard one at a time,
after someone has reviewed the content for pasted credentials and unpublished drafts.

The change is additive going forward but not cleanly reversible: a `push` collection created before a
revert holds a `source` value the reverted union no longer knows. Documents stay intact, but such
collections must be deleted by hand. Pilot on a collection you are willing to discard.

## Future work (explicitly not built now)

- **Phase 2 — workspace bindings, for relevance.** Global collections stay ambient; additional
  collections are bound only to the workspaces that need them. The mechanism already exists and is the
  one behind every other resource binding: a gatekeeper declares `getSupportedResources()`, the user
  connects a resource URL to a gadget, and the Workshop records the gatekeeper on that workspace's
  Overseer. Context opts out today — under a header reading "no URL-addressed resources",
  `getSupportedResources()` returns `[]` and `getGatekeeperClassFor()` throws. Phase 2 gives
  collections their own URLs (`context://collection/<id>`) and returns a session pinned to one. Note
  this is not a boundary: a public collection stays readable by everyone.
- **Phase 3 — a restricted visibility, for access.** Only if a concrete case appears. No user/group
  permission model should be attempted: the platform has no group or claim concept anywhere,
  `createAccount()` takes no identity, and the sole precedent for per-user authority reaching a
  gatekeeper is the UI-only `AppUiContext.isAdmin`.
- **A search index**, if the measurement at the end of phase 1 demands it.
- **A pull-based source**, behind the same collection-source abstraction, for repositories that will
  never carry a workflow.
- **Per-document provenance and citations.**

## Testing

Unit tests for the pure pieces: manifest diffing, hash computation and verification, batch planning,
and every route's status codes.

Durable Object tests for the stateful ones:

- A valid token stages and commits; documents and hashes are stored.
- A wrong, revoked or expired token is rejected on every route, and nothing is written.
- A token for collection A cannot publish to collection B.
- `plan` on an unchanged commit returns `unchanged` and opens no session.
- `plan` returns only the paths whose hash differs or is missing.
- An upload whose body does not match its manifest hash is rejected.
- `commit` with outstanding uploads is refused and changes nothing.
- `commit` deletes documents absent from the manifest and leaves unchanged ones untouched.
- A second `plan` discards the first session's staging.
- A `SKILL.md` in the published content produces a slash command.

Then one pilot repository end-to-end: publish, edit one file and confirm only that file transfers,
delete a file and confirm it disappears, and confirm an agent finds the content.

## Rollout

Ship the protocol and tokens → pilot one repository end-to-end → **measure search latency against the
loaded wiki** and decide whether the retrieval work is needed → then onboard the rest, one at a time
with content review.

## Out of scope

Department or per-user scoping, embeddings or semantic search, an MCP server over the Library,
per-document provenance and citations, pulling from GitHub, webhook-triggered refresh, and
repository-sourced system-prompt instructions.
