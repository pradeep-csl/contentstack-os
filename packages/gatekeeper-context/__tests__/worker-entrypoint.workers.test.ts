// Exercises the real default export (src/index.ts) through SELF.fetch(), not the fake resolver
// ingest-handler.test.ts uses. This is the only place the rate-limiter-before-resolve ordering, the
// ctx.exports wiring, and the fallthrough to the plain-text response are proven end to end.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://gatekeeper-context";
const PREFIX = "/gatekeeper/context/ingest/test";

// Collection ids are UUIDs, and the handler refuses anything else before it resolves a collection,
// so each test that must reach the collection uses a real one. Distinct per test, because the
// per-collection rate limiter is keyed on exactly this and the test config's limit is 1.
const RATE_LIMIT_ID = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
const ENCODING_ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

function post(path: string, headers: HeadersInit = {}, body: unknown = { commit: "c1", manifest: [] }) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("worker entrypoint", () => {
  it("falls through to the plain-text response for a non-ingestion path", async () => {
    let response = await SELF.fetch(`${ORIGIN}/whatever`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Context Library worker is running.");
  });

  it("rejects an unauthenticated ingestion request with 401, proving fetch wires into handleIngestRequest", async () => {
    let response = await post(`${PREFIX}/f81d4fae-7dec-11d0-a765-00a0c91e6bf6/plan`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("404s an unknown action under the ingestion prefix", async () => {
    let response = await post(`${PREFIX}/886313e1-3b8a-5372-9b90-0c9aee199e5d/frobnicate`);
    expect(response.status).toBe(404);
  });

  it("404s a malformed percent-escape rather than throwing out of fetch()", async () => {
    // decodeURIComponent throws URIError on `%ZZ`, which the URL parser leaves in the pathname. Left
    // unguarded it propagates out of the entrypoint as a 500 with an exception in the observability
    // stream — unauthenticated, repeatable, and raised before either limiter has been charged, which
    // is exactly the case the global ceiling exists to cover.
    let response = await post(`${PREFIX}/%ZZ/plan`);
    expect(response.status).toBe(404);
  });

  it("blocks a request over the rate limit before the collection is resolved", async () => {
    // Same path both times, so both share the limiter's key and the test config's limit of 1 (see
    // vitest.workers.config.ts) is exhausted by the first call. A syntactically valid but wrong
    // bearer token, not no token at all: an empty token is rejected by ingest-handler.ts's own
    // `if (!token) return json(401, ...)` check before it ever calls resolve(), which would make
    // both calls 401 regardless of where the limiter sits and prove nothing about ordering. A
    // present-but-wrong token instead forces the request through resolve() and
    // verifyIngestToken() before it can fail, so the sequence below actually turns on the limiter.
    let headers = { authorization: "Bearer bogus" };
    let path = `${PREFIX}/${RATE_LIMIT_ID}/plan`;

    // Under the limit: the limiter lets the request through, so it reaches resolve() and
    // verifyIngestToken(), which reject the bogus token with 401 — the same path the "unauthenticated"
    // test above takes, just failing on token validity instead of token presence.
    let first = await post(path, headers);
    expect(first.status).toBe(401);

    // Over the limit, identical request otherwise: if this call still reached verifyIngestToken(), it
    // would fail the same bogus-token check as `first` and also return 401 (the check is a pure
    // function of the same path + same token). Getting 429 instead is behavioral evidence — not proof
    // by instrumenting resolve() itself, which no test in this harness does across the Worker
    // boundary — that the limiter short-circuited before the request got that far.
    let second = await post(path, headers);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate limited" });
  });

  it("charges two spellings of one collection path to the same budget", async () => {
    // The handler normalizes the path — empty segments dropped, each segment decoded — before it
    // resolves the collection, so these two URLs address one Durable Object. Keying the limiter on
    // the raw pathname would give them a budget each, and an unauthenticated caller could mint as
    // many budgets as it can spell the same path. A present-but-wrong token, so both requests get
    // past the handler's own missing-token check and the limiter is what decides the second one.
    let headers = { authorization: "Bearer bogus" };

    let first = await post(`${PREFIX}/${ENCODING_ID}/plan`, headers);
    expect(first.status).toBe(401);

    // Same route, spelled with an empty segment and a percent-encoded action.
    let second = await post(`${PREFIX}//${ENCODING_ID}/%70lan`, headers);
    expect(second.status).toBe(429);
  });
});
