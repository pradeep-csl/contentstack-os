// Exercises the real default export (src/index.ts) through SELF.fetch(), not the fake resolver
// ingest-handler.test.ts uses. This is the only place the rate-limiter-before-resolve ordering, the
// ctx.exports wiring, and the fallthrough to the plain-text response are proven end to end.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://gatekeeper-context";

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
    let response = await post("/gatekeeper/context/ingest/test/entrypoint-401/plan");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("404s an unknown action under the ingestion prefix", async () => {
    let response = await post("/gatekeeper/context/ingest/test/entrypoint-404/frobnicate");
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
    let path = "/gatekeeper/context/ingest/test/entrypoint-ratelimit/plan";

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
});
