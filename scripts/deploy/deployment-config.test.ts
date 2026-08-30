import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { readWranglerConfig } from "../release/manifest-lib.ts";
import {
  DEFAULT_GATEKEEPER_SECRETS,
  deploymentTiers,
  gatekeeperBindingName,
  gatekeeperShortName,
  gatekeepersOf,
  generateProdConfig,
  modelCatalogVars,
  parseJsonc,
  requiredResources,
  requiredSecretsFor,
  resourceNameFor,
  sharingDomainOf,
  validateDeployment,
  type DeploymentConfig,
} from "./deployment-config.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** A deployment covering every code path: both required workers, an ambient and an OAuth gatekeeper. */
function baseDeployment(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    accountId: "0123456789abcdef0123456789abcdef",
    publicBaseUrl: "https://os-router.acme.workers.dev",
    route: { workersDev: true },
    admins: ["admin@example.com"],
    auth: { gatekeepers: ["github"], disablePassword: false },
    workers: {
      router: "os-router",
      "workshop-backend": "os-workshop",
      "gatekeeper-context": "os-context",
      "gatekeeper-github": "os-github",
    },
    aiGateway: { enabled: false, name: "default", accountId: null, providers: ["cloudflare"] },
    openRouter: { enabled: false, models: null, quickModel: null, baseUrl: null },
    mcpPortal: { url: null, name: null, auth: "oauth", trustAnnotations: false },
    context: { sharingDomain: null, artifacts: null },
    resources: {},
    observability: {
      enabled: true, headSamplingRate: 1, invocationLogs: false,
      traces: { enabled: false, headSamplingRate: 0.1 },
    },
    ...overrides,
  };
}

function base(pkgName: string) {
  return readWranglerConfig(join(ROOT, "packages", pkgName));
}

describe("binding names", () => {
  // The router derives its `/gatekeeper/<segment>` route back from the binding name by lowercasing
  // and turning `_` into `-`. If these two stop being inverses, every multi-word gatekeeper becomes
  // unreachable through the router while still deploying and binding cleanly.
  it("round-trips a multi-word gatekeeper through the router's transform", () => {
    for (const pkgName of ["gatekeeper-github", "gatekeeper-mcp-portal", "gatekeeper-home-assistant"]) {
      const binding = gatekeeperBindingName(pkgName);
      const routerSegment = binding.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      assert.equal(routerSegment, gatekeeperShortName(pkgName), pkgName);
    }
  });
});

describe("deployment tiers", () => {
  // Each tier's service bindings name what the tier before it produced, so a reordering here
  // deploys a worker that binds a service which does not exist yet.
  it("puts gatekeepers before the backend, and the backend before the router", () => {
    const config = baseDeployment();
    assert.deepEqual(deploymentTiers(config), [
      ["gatekeeper-context", "gatekeeper-github"],
      ["workshop-backend"],
      ["router"],
    ]);
  });

  it("sorts gatekeepers, so the deploy order does not depend on key order", () => {
    const workers = {
      router: "r", "workshop-backend": "w",
      "gatekeeper-scheduler": "s", "gatekeeper-context": "c",
    };
    assert.deepEqual(gatekeepersOf(baseDeployment({ workers })),
        ["gatekeeper-context", "gatekeeper-scheduler"]);
  });
});

describe("storage naming", () => {
  // Derived from the worker name, which is a permanent service identity. Deriving it from anything
  // that can change would point a redeploy at empty storage.
  it("derives a name from the worker name and the binding", () => {
    const config = baseDeployment();
    assert.deepEqual(resourceNameFor(config, "workshop-backend", "BLUEPRINT_CONTENT"),
        { name: "os-workshop-blueprint-content", explicit: false });
  });

  it("marks a configured name explicit, so the deploy adopts rather than creates it", () => {
    const config = baseDeployment({ resources: { "workshop-backend.BLUEPRINTS": "legacy-kv" } });
    assert.deepEqual(resourceNameFor(config, "workshop-backend", "BLUEPRINTS"),
        { name: "legacy-kv", explicit: true });
  });

  it("covers every KV and R2 binding the deployed packages declare", () => {
    const config = baseDeployment();
    const found = requiredResources(config, {
      "workshop-backend": base("workshop-backend"),
      "gatekeeper-context": base("gatekeeper-context"),
      "gatekeeper-github": base("gatekeeper-github"),
      router: base("router"),
    });
    assert.deepEqual(found.map(r => `${r.kind}:${r.pkgName}/${r.binding}`), [
      "kv:gatekeeper-context/CONTEXT_COLLECTIONS",
      "kv:workshop-backend/BLUEPRINTS",
      "kv:workshop-backend/AVATARS",
      "r2:workshop-backend/BLUEPRINT_CONTENT",
    ]);
  });
});

describe("required secrets", () => {
  it("gives an OAuth connector the client credential pair", () => {
    assert.deepEqual(requiredSecretsFor(baseDeployment(), "gatekeeper-github"),
        DEFAULT_GATEKEEPER_SECRETS);
  });

  it("asks nothing of the ambient gatekeepers", () => {
    for (const pkgName of ["gatekeeper-context", "gatekeeper-scheduler"]) {
      assert.deepEqual(requiredSecretsFor(baseDeployment(), pkgName), []);
    }
  });

  it("asks for a portal bearer only under token auth", () => {
    const oauth = baseDeployment({ mcpPortal: { url: "https://p/mcp", name: null, auth: "oauth", trustAnnotations: false } });
    const token = baseDeployment({ mcpPortal: { url: "https://p/mcp", name: null, auth: "token", trustAnnotations: false } });
    assert.deepEqual(requiredSecretsFor(oauth, "gatekeeper-mcp-portal"), []);
    assert.deepEqual(requiredSecretsFor(token, "gatekeeper-mcp-portal"), ["MCP_PORTAL_TOKEN"]);
  });

  // The WORKERS_AI binding transport is pre-authenticated in-account, so the token is genuinely
  // optional -- except for the two cases the binding cannot serve. Getting this wrong means a
  // gateway deployment that looks complete and fails at the first inference call.
  it("requires the gateway token only where the binding transport cannot serve", () => {
    const inAccount = baseDeployment({
      aiGateway: { enabled: true, name: "g", accountId: null, providers: ["cloudflare", "anthropic"] },
    });
    assert.deepEqual(requiredSecretsFor(inAccount, "workshop-backend"), []);

    const google = baseDeployment({
      aiGateway: { enabled: true, name: "g", accountId: null, providers: ["google"] },
    });
    assert.deepEqual(requiredSecretsFor(google, "workshop-backend"), ["CF_AI_GATEWAY_API_TOKEN"]);

    const crossAccount = baseDeployment({
      aiGateway: {
        enabled: true, name: "g", providers: ["cloudflare"],
        accountId: "ffffffffffffffffffffffffffffffff",
      },
    });
    assert.deepEqual(requiredSecretsFor(crossAccount, "workshop-backend"), ["CF_AI_GATEWAY_API_TOKEN"]);
  });

  it("requires the OpenRouter key, which has no per-user fallback", () => {
    const config = baseDeployment({
      openRouter: { enabled: true, models: null, quickModel: null, baseUrl: null },
    });
    assert.deepEqual(requiredSecretsFor(config, "workshop-backend"), ["OPENROUTER_API_KEY"]);
  });
});

describe("generated backend config", () => {
  const config = baseDeployment({
    aiGateway: { enabled: true, name: "acme-ai", accountId: null, providers: ["cloudflare"] },
  });
  const generated = generateProdConfig("workshop-backend", base("workshop-backend"), config,
      { BLUEPRINTS: "kv1", AVATARS: "kv2", BLUEPRINT_CONTENT: "os-workshop-blueprint-content" });

  it("pins the account and the configured worker name", () => {
    assert.equal(generated.account_id, config.accountId);
    assert.equal(generated.name, "os-workshop");
  });

  it("resolves KV ids and drops the dev-only preview_id", () => {
    assert.deepEqual(generated.kv_namespaces,
        [{ binding: "BLUEPRINTS", id: "kv1" }, { binding: "AVATARS", id: "kv2" }]);
    assert.ok(!JSON.stringify(generated.kv_namespaces).includes("preview_id"));
  });

  it("binds every gatekeeper through the vendor entrypoint", () => {
    const vendors = (generated.services ?? []).filter(s => s.binding.startsWith("GATEKEEPER_"));
    assert.deepEqual(vendors.map(s => [s.binding, s.service, s.entrypoint]), [
      ["GATEKEEPER_CONTEXT", "os-context", "GatekeeperVendor"],
      ["GATEKEEPER_GITHUB", "os-github", "GatekeeperVendor"],
    ]);
  });

  // The Context Library keys all of its stored data by this prop. An absent or drifting value does
  // not fail a deploy -- it silently hides every existing collection.
  it("carries the Context sharingDomain in the binding props", () => {
    const context = (generated.services ?? []).find(s => s.binding === "GATEKEEPER_CONTEXT");
    assert.deepEqual(context?.props, { sharingDomain: config.publicBaseUrl });
  });

  it("injects the Workers AI binding and the gateway vars", () => {
    assert.deepEqual(generated.ai, { binding: "WORKERS_AI" });
    assert.equal(generated.vars?.CF_AI_GATEWAY, "acme-ai");
    assert.equal(generated.vars?.CF_AI_GATEWAY_ACCOUNT_ID, config.accountId);
    // In-account: the binding is the transport, so the opt-out must NOT be set.
    assert.equal(generated.vars?.CF_AI_GATEWAY_USE_BINDING, undefined);
  });

  it("opts out of the binding transport for a gateway in another account", () => {
    const crossAccount = baseDeployment({
      aiGateway: {
        enabled: true, name: "g", providers: ["cloudflare"],
        accountId: "ffffffffffffffffffffffffffffffff",
      },
    });
    const out = generateProdConfig("workshop-backend", base("workshop-backend"), crossAccount);
    assert.equal(out.vars?.CF_AI_GATEWAY_USE_BINDING, "false");
    assert.equal(out.vars?.CF_AI_GATEWAY_ACCOUNT_ID, "ffffffffffffffffffffffffffffffff");
  });

  // Every OpenRouter var except the key is deployment configuration, and each has a code-side
  // default -- so an unset one is indistinguishable from a wrong one until a model call fails.
  it("carries every non-secret OpenRouter var it is given", () => {
    const config = baseDeployment({
      openRouter: {
        enabled: true,
        models: ["anthropic/claude-sonnet-5", "openai/gpt-5.6-sol"],
        quickModel: "anthropic/claude-haiku-4.5",
        baseUrl: "https://proxy.example.com/api/v1",
      },
    });
    const out = generateProdConfig("workshop-backend", base("workshop-backend"), config);
    assert.equal(out.vars?.OPENROUTER_MODELS, "anthropic/claude-sonnet-5,openai/gpt-5.6-sol");
    assert.equal(out.vars?.OPENROUTER_QUICK_MODEL, "anthropic/claude-haiku-4.5");
    assert.equal(out.vars?.OPENROUTER_BASE_URL, "https://proxy.example.com/api/v1");
    // The key is a secret: it must never appear in a generated config.
    assert.ok(!JSON.stringify(out).includes("OPENROUTER_API_KEY"));
  });

  it("passes ADMINS as an array and enables the configured sign-in gatekeepers", () => {
    assert.deepEqual(generated.vars?.ADMINS, ["admin@example.com"]);
    assert.equal(generated.vars?.AUTH_GATEKEEPERS, "github");
    assert.equal(generated.vars?.PUBLIC_BASE_URL, config.publicBaseUrl);
    assert.equal(generated.vars?.DISABLE_PASSWORD_AUTH, undefined);
  });

  it("keeps the committed migration history verbatim", () => {
    assert.deepEqual(generated.migrations, base("workshop-backend").migrations);
  });
});

describe("generated router config", () => {
  it("publishes on workers.dev and binds gatekeepers on the default entrypoint", () => {
    const generated = generateProdConfig("router", base("router"), baseDeployment());
    assert.equal(generated.workers_dev, true);
    assert.equal(generated.routes, undefined);

    const services = generated.services ?? [];
    // The committed binding says `service: "workshop-backend"` -- the package name, not this
    // deployment's worker name.
    assert.deepEqual(services.find(s => s.binding === "WORKSHOP_BACKEND"),
        { binding: "WORKSHOP_BACKEND", service: "os-workshop" });
    for (const svc of services.filter(s => s.binding.startsWith("GATEKEEPER_"))) {
      assert.equal(svc.entrypoint, undefined, `${svc.binding} must use the default entrypoint`);
    }
  });

  it("uses a custom-domain route when one is configured", () => {
    const config = baseDeployment({
      route: { customDomain: "os.example.com" },
      publicBaseUrl: "https://os.example.com",
    });
    const generated = generateProdConfig("router", base("router"), config);
    assert.equal(generated.workers_dev, false);
    assert.deepEqual(generated.routes, [{ pattern: "os.example.com", custom_domain: true }]);
  });

  it("keeps serving the frontend bundle", () => {
    const generated = generateProdConfig("router", base("router"), baseDeployment());
    assert.equal(generated.assets?.directory, "../workshop-frontend/dist");
    assert.equal(generated.assets?.binding, "ASSETS");
  });
});

describe("generated gatekeeper config", () => {
  it("points BASE_URL at the router path that reaches it", () => {
    const config = baseDeployment();
    const generated = generateProdConfig("gatekeeper-github", base("gatekeeper-github"), config);
    assert.equal(generated.vars?.BASE_URL, `${config.publicBaseUrl}/gatekeeper/github`);
  });

  it("preserves the committed vars a deployment does not override", () => {
    const config = baseDeployment({
      workers: { ...baseDeployment().workers, "gatekeeper-mcp-portal": "os-portal" },
      mcpPortal: { url: "https://portal.example.com/mcp", name: "Acme", auth: "oauth", trustAnnotations: false },
    });
    const generated = generateProdConfig("gatekeeper-mcp-portal", base("gatekeeper-mcp-portal"), config);
    // Pinned to "false" in the committed config; a deployment must not lose it.
    assert.equal(generated.vars?.MCP_ALLOW_INSECURE, "false");
    assert.equal(generated.vars?.MCP_PORTAL_URL, "https://portal.example.com/mcp");
    assert.equal(generated.vars?.MCP_PORTAL_NAME, "Acme");
    assert.equal(generated.vars?.MCP_PORTAL_TRUST_ANNOTATIONS, undefined);
  });

  it("keeps the rate limiters that bound the ingestion endpoint", () => {
    const generated = generateProdConfig("gatekeeper-context", base("gatekeeper-context"), baseDeployment());
    assert.deepEqual(generated.ratelimits, base("gatekeeper-context").ratelimits);
  });

  it("binds Artifacts only when the deployment enables it", () => {
    const off = generateProdConfig("gatekeeper-context", base("gatekeeper-context"), baseDeployment());
    assert.equal(off.artifacts, undefined);
    const on = generateProdConfig("gatekeeper-context", base("gatekeeper-context"),
        baseDeployment({ context: { sharingDomain: null, artifacts: { enabled: true, namespace: null } } }));
    assert.deepEqual(on.artifacts, { binding: "ARTIFACTS" });
  });
});

describe("model catalog vars", () => {
  // These are what `run-dev-server.ts` seeds local development from, so the deployment states the
  // catalog once. The vars must match what generateProdConfig writes, or dev and production run
  // different model lists while both look configured.
  it("matches the vars the generated backend config carries", () => {
    const config = baseDeployment({
      openRouter: {
        enabled: true,
        models: ["anthropic/claude-sonnet-5"],
        quickModel: "anthropic/claude-haiku-4.5",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    });
    const seeded = modelCatalogVars(config);
    const deployed = generateProdConfig("workshop-backend", base("workshop-backend"), config).vars ?? {};
    for (const [key, value] of Object.entries(seeded)) {
      assert.equal(deployed[key], value, key);
    }
    assert.deepEqual(Object.keys(seeded).toSorted(),
        ["OPENROUTER_BASE_URL", "OPENROUTER_MODELS", "OPENROUTER_QUICK_MODEL"]);
  });

  it("seeds nothing when the gateway is off, so callers can seed unconditionally", () => {
    assert.deepEqual(modelCatalogVars(baseDeployment()), {});
  });

  // A deployment description is not a secret store; a key seeded from one is a key nobody
  // remembers is there.
  it("never carries the API key", () => {
    const config = baseDeployment({
      openRouter: { enabled: true, models: null, quickModel: null, baseUrl: null },
    });
    assert.deepEqual(modelCatalogVars(config), {});
  });
});

describe("sharing domain", () => {
  it("defaults to the public origin and honours an override", () => {
    assert.equal(sharingDomainOf(baseDeployment()), "https://os-router.acme.workers.dev");
    assert.equal(
      sharingDomainOf(baseDeployment({ context: { sharingDomain: "acme", artifacts: null } })), "acme");
  });
});

describe("validation", () => {
  it("accepts the base deployment", () => {
    assert.deepEqual(validateDeployment(baseDeployment(), ROOT), []);
  });

  it("rejects a malformed account id", () => {
    const errors = validateDeployment(baseDeployment({ accountId: "nope" }), ROOT);
    assert.ok(errors.some(e => e.includes("accountId must be 32 hex")), errors.join("\n"));
  });

  it("rejects an origin with a path or a trailing slash", () => {
    for (const url of ["https://os.example.com/", "https://os.example.com/app", "os.example.com"]) {
      const errors = validateDeployment(baseDeployment({ publicBaseUrl: url }), ROOT);
      assert.ok(errors.some(e => e.includes("publicBaseUrl")), `${url}: ${errors.join("\n")}`);
    }
  });

  // These two are read by different consumers -- wrangler publishes on one, every OAuth redirect
  // URI is built from the other -- so a mismatch is a working deploy with a broken sign-in.
  it("rejects a custom domain that disagrees with the public origin", () => {
    const errors = validateDeployment(baseDeployment({
      route: { customDomain: "os.example.com" },
      publicBaseUrl: "https://other.example.com",
    }), ROOT);
    assert.ok(errors.some(e => e.includes("does not match route.customDomain")), errors.join("\n"));
  });

  it("requires both core workers", () => {
    for (const pkgName of ["router", "workshop-backend"]) {
      const workers = { ...baseDeployment().workers };
      delete workers[pkgName];
      const errors = validateDeployment(baseDeployment({ workers }), ROOT);
      assert.ok(errors.some(e => e.includes(`workers."${pkgName}" is required`)), errors.join("\n"));
    }
  });

  it("rejects a package with no wrangler.jsonc in this checkout", () => {
    const workers = { ...baseDeployment().workers, "gatekeeper-nonexistent": "x" };
    const errors = validateDeployment(baseDeployment({ workers }), ROOT);
    assert.ok(errors.some(e => e.includes("has no packages/gatekeeper-nonexistent/wrangler.jsonc")),
        errors.join("\n"));
  });

  it("rejects a duplicated worker name", () => {
    const workers = { ...baseDeployment().workers, "gatekeeper-context": "os-router" };
    const errors = validateDeployment(baseDeployment({ workers }), ROOT);
    assert.ok(errors.some(e => e.includes('"os-router" is used more than once')), errors.join("\n"));
  });

  // An auth gatekeeper that is not deployed produces a "Continue with ..." button wired to a
  // service binding that does not exist.
  it("rejects a sign-in gatekeeper that is not deployed", () => {
    const config = baseDeployment({ auth: { gatekeepers: ["github", "slack"], disablePassword: false } });
    const errors = validateDeployment(config, ROOT);
    assert.ok(errors.some(e => e.includes('has no "gatekeeper-slack"')), errors.join("\n"));
  });

  it("rejects disabling passwords with no other way in", () => {
    const config = baseDeployment({ auth: { gatekeepers: [], disablePassword: true } });
    const errors = validateDeployment(config, ROOT);
    assert.ok(errors.some(e => e.includes("no way to sign in")), errors.join("\n"));
  });

  it("rejects an unknown AI Gateway provider", () => {
    const config = baseDeployment({
      aiGateway: { enabled: true, name: "g", accountId: null, providers: ["bedrock"] },
    });
    const errors = validateDeployment(config, ROOT);
    assert.ok(errors.some(e => e.includes('contains "bedrock"')), errors.join("\n"));
  });

  it("rejects deploying the MCP portal with no portal URL", () => {
    const workers = { ...baseDeployment().workers, "gatekeeper-mcp-portal": "os-portal" };
    const errors = validateDeployment(baseDeployment({ workers }), ROOT);
    assert.ok(errors.some(e => e.includes("mcpPortal.url is unset")), errors.join("\n"));
  });

  it("rejects a resources key naming a package that is not deployed", () => {
    const config = baseDeployment({ resources: { "gatekeeper-slack.FOO": "bar" } });
    const errors = validateDeployment(config, ROOT);
    assert.ok(errors.some(e => e.includes('is not deployed')), errors.join("\n"));
  });
});

describe("deployment.example.jsonc", () => {
  // The template is what everyone starts from, so a key renamed in the validator and not here
  // fails on the reader's first run rather than in CI.
  it("parses, and fails validation only on its own placeholders", () => {
    const path = join(ROOT, "deployment.example.jsonc");
    const example = parseJsonc<DeploymentConfig>(readFileSync(path, "utf8"), path);

    const errors = validateDeployment(example, ROOT);
    // Every remaining complaint must be about a `<PLACEHOLDER>` the reader has to fill in, not
    // about a key that no longer exists or a shape that drifted.
    for (const error of errors) {
      assert.ok(/<[A-Z_]+>/.test(error), `unexpected template error: ${error}`);
    }

    // The example's worker set must be deployable from this checkout.
    for (const pkgName of Object.keys(example.workers)) {
      assert.doesNotThrow(() => base(pkgName), `packages/${pkgName} is missing`);
    }
  });
});
