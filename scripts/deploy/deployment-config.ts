// Turns one `deployment.jsonc` plus each package's committed `wrangler.jsonc` into the
// `wrangler.prod.jsonc` files `wrangler deploy` is run against.
//
// This is the self-hosting counterpart of the two generators that already exist here:
// `scripts/run-dev-server.ts` resolves the same binding topology to localhost, and
// `scripts/release/manifest-lib.ts` resolves it to `$PLACEHOLDER` templates for Cloudflare's
// hosted deploy service. This one resolves it to concrete values for one account you own.
//
// Everything in this module is pure -- it reads and parses files, but performs no network calls
// and spawns nothing -- so `deployment-config.test.ts` can pin the whole topology without a
// Cloudflare account. `deploy.ts` owns provisioning, building and deploying.
//
// Two properties are load-bearing and are asserted rather than assumed:
//
//   - `publicBaseUrl` is both what OAuth redirect URIs are built from and the Context Library's
//     `sharingDomain`, which is a data-isolation boundary. A value that changes silently hides
//     collections rather than breaking a link, so it is required rather than guessed.
//   - Storage resource names are derived from the *worker* name, which is a permanent service
//     identity. Deriving them from anything mutable would point a redeploy at empty storage.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { readWranglerConfig, type ServiceBinding, type WranglerConfig } from "../release/manifest-lib.ts";

/** How the router is published: an account's workers.dev subdomain, or a hostname in a zone. */
export type RouterRoute =
  | { workersDev: true; customDomain?: never }
  | { workersDev?: never; customDomain: string };

/** Which gatekeepers may drive sign-in, and whether password accounts remain available. */
export interface AuthConfig {
  /**
   * Gatekeeper vendor ids allowed to authenticate, e.g. `["github", "google"]`. Each must also
   * advertise `providesAuth` and be present in `workers`. Empty leaves password accounts as the
   * only way in.
   */
  gatekeepers: string[];
  /**
   * Hide username/password login and signup. Ignored while `gatekeepers` is empty, mirroring
   * `isPasswordAuthEnabled()` in the backend, so a misconfiguration cannot lock everyone out.
   */
  disablePassword: boolean;
}

/** Cloudflare AI Gateway settings: the platform-managed model catalog. */
export interface AiGatewayConfig {
  /** Whether the deployment serves models through a Gateway at all. Off means every user brings their own key. */
  enabled: boolean;
  /** The Gateway's name in the owning account. */
  name: string;
  /** Gateway owner account, when it is not the account the Workers live in. */
  accountId: string | null;
  /** Providers served through the Gateway, e.g. `["cloudflare", "anthropic"]`. */
  providers: string[];
}

/** OpenRouter gateway settings. The API key itself is a secret and never lands in a config. */
export interface OpenRouterConfig {
  /** Whether OpenRouter models are offered. Requires the `OPENROUTER_API_KEY` secret. */
  enabled: boolean;
  /** Model id override replacing the curated catalog, or null to keep it. */
  models: string[] | null;
  /** Quick/title model, or null for the built-in default. */
  quickModel: string | null;
  /** API base, for a proxy in front of OpenRouter. Null uses `https://openrouter.ai/api/v1`. */
  baseUrl: string | null;
}

/** The admin-configured MCP portal `gatekeeper-mcp-portal` fronts. */
export interface McpPortalConfig {
  /** The portal's Streamable HTTP MCP endpoint. Null leaves the connector hidden. */
  url: string | null;
  /** Display name in the connector list and every approval prompt, or null for the default. */
  name: string | null;
  /** How the portal authenticates: `oauth` (default), `none`, or `token`. */
  auth: "oauth" | "none" | "token";
  /**
   * Let tool annotations from behind the portal auto-approve writes. Only set this where every
   * upstream server the portal aggregates is itself trusted.
   */
  trustAnnotations: boolean;
}

/** Context Library settings. */
export interface ContextConfig {
  /**
   * Namespace every collection is scoped to. Null derives it from `publicBaseUrl`, which is what
   * the release manifest does. Changing it hides existing collections.
   */
  sharingDomain: string | null;
  /** Bind an Artifacts namespace to enable Git-backed collections. Requires account access. */
  artifacts: { enabled: boolean; namespace: string | null } | null;
}

/** Workers observability settings, in the shape `deployment.jsonc` spells them. */
export interface ObservabilitySettings {
  /** Whether observability is on at all. */
  enabled: boolean;
  /** Fraction of requests sampled. */
  headSamplingRate: number;
  /** Whether Wrangler's own per-invocation logs are kept, on top of the structured ones. */
  invocationLogs: boolean;
  /** Tracing, billed against the Logs quota from 2026-10-01. */
  traces: { enabled: boolean; headSamplingRate: number };
}

/** One deployment of this repo into one Cloudflare account. */
export interface DeploymentConfig {
  /** The account that owns every Worker and provisioned resource. */
  accountId: string;
  /**
   * The deployment's public origin -- a bare origin, no path and no trailing slash. On
   * workers.dev this is `https://<router worker>.<account subdomain>.workers.dev`; the subdomain
   * is not derivable from this file, which is why the value is required either way.
   */
  publicBaseUrl: string;
  /** How the router is published. */
  route: RouterRoute;
  /** Deployment-wide admins, by the identity the chosen sign-in method yields (email, or username). */
  admins: string[];
  /** Sign-in configuration. */
  auth: AuthConfig;
  /**
   * Worker name per deployed package. **The key set is the deployment**: `router` and
   * `workshop-backend` are required, and every `gatekeeper-*` key present is deployed and bound
   * into both. Adding a connector later is one more key here plus a redeploy.
   */
  workers: Record<string, string>;
  /** Cloudflare AI Gateway settings. */
  aiGateway: AiGatewayConfig;
  /** OpenRouter gateway settings. */
  openRouter: OpenRouterConfig;
  /** MCP portal settings, read only when `gatekeeper-mcp-portal` is deployed. */
  mcpPortal: McpPortalConfig;
  /** Context Library settings, read only when `gatekeeper-context` is deployed. */
  context: ContextConfig;
  /**
   * Explicit storage resource identifiers, keyed `<package>.<BINDING>`. Absent or null entries
   * are derived by {@link resourceNameFor} and provisioned on first deploy.
   */
  resources: Record<string, string | null>;
  /** Observability settings applied to every worker. */
  observability: ObservabilitySettings;
}

/** A generated `wrangler.prod.jsonc`: a committed config with every deployment value resolved. */
export interface ProdWranglerConfig extends WranglerConfig {
  /** The account this worker deploys to. Pinned per config so no ambient default can win. */
  account_id: string;
  /** Whether the worker answers on the account's workers.dev subdomain. Only the router does. */
  workers_dev?: boolean;
  /** Custom-domain routes. Only the router has any. */
  routes?: { pattern: string; custom_domain: true }[];
  /** The Workers AI binding, injected for the backend. */
  ai?: { binding: string };
}

/** A storage resource a worker needs before it can be deployed. */
export interface RequiredResource {
  /** The package that binds it. */
  pkgName: string;
  /** Binding name the worker reads. */
  binding: string;
  /** Which API provisions it. */
  kind: "kv" | "r2";
  /** The namespace title or bucket name, derived or explicitly configured. */
  name: string;
  /** True when `resources` named it explicitly, so `deploy.ts` must not rename it. */
  explicit: boolean;
}

/** The repo-relative directory holding every deployable package. */
export const PACKAGES_DIR = "packages";

/** File name of the generated per-package config. Gitignored -- it is build output. */
export const PROD_CONFIG_NAME = "wrangler.prod.jsonc";

/** File name of the deployment description this module reads. */
export const DEPLOYMENT_CONFIG_NAME = "deployment.jsonc";

/** Packages that must be present in `workers`; a deployment without either is not one. */
export const REQUIRED_PACKAGES = ["router", "workshop-backend"] as const;

/** Prefix marking a package as a gatekeeper, in `workers` and on disk. */
export const GATEKEEPER_PREFIX = "gatekeeper-";

/** RPC entrypoint the backend reaches every gatekeeper through. */
export const VENDOR_ENTRYPOINT = "GatekeeperVendor";

/** Providers the Cloudflare AI Gateway can serve. */
export const AI_GATEWAY_PROVIDERS = ["cloudflare", "anthropic", "openai", "google"] as const;

/**
 * Secrets each gatekeeper needs before its connector works, mirroring `DEFAULT_CRED_INPUTS` and
 * `NO_DEFAULT_CRED_INPUTS` in `manifest-lib.ts`. A gatekeeper absent from this map takes the
 * default OAuth app pair; one mapped to `[]` takes none.
 */
export const GATEKEEPER_SECRETS: Record<string, string[]> = {
  "gatekeeper-context": [],
  "gatekeeper-scheduler": [],
  "gatekeeper-homeassistant": [],
  "gatekeeper-mcp": [],
  // MCP OAuth uses dynamic client registration; a bearer is needed only for `auth: "token"`.
  "gatekeeper-mcp-portal": [],
};

/** The OAuth app credentials an installable gatekeeper takes when it fronts a third-party service. */
export const DEFAULT_GATEKEEPER_SECRETS = ["CLIENT_ID", "CLIENT_SECRET"];

/** Secrets the backend reads. Both are optional; each unlocks one gateway. */
export const BACKEND_SECRETS = ["OPENROUTER_API_KEY", "CF_AI_GATEWAY_API_TOKEN"];

const ACCOUNT_ID_PATTERN = /^[a-f\d]{32}$/i;
const ORIGIN_PATTERN = /^https:\/\/[^/?#\s]+$/;

/**
 * The `GATEKEEPER_*` binding name a gatekeeper package is bound under. The router derives its
 * `/gatekeeper/<short>` route back from this name, so the two transforms must stay inverses:
 * `gatekeeper-mcp-portal` -> `GATEKEEPER_MCP_PORTAL` -> `mcp-portal`.
 */
export function gatekeeperBindingName(pkgName: string): string {
  return pkgName.toUpperCase().replaceAll("-", "_");
}

/** The path segment the router routes `/gatekeeper/<segment>/*` on, e.g. `mcp-portal`. */
export function gatekeeperShortName(pkgName: string): string {
  return pkgName.slice(GATEKEEPER_PREFIX.length);
}

/** Every gatekeeper package the deployment includes, sorted for a stable deploy order. */
export function gatekeepersOf(config: DeploymentConfig): string[] {
  return Object.keys(config.workers).filter(name => name.startsWith(GATEKEEPER_PREFIX)).toSorted();
}

/**
 * Deploy order, as tiers that must complete in sequence: every gatekeeper first (nothing binds to
 * anything), then the backend (which binds every gatekeeper), then the router (which binds the
 * backend and every gatekeeper, and owns the public origin). Within a tier, order is irrelevant.
 */
export function deploymentTiers(config: DeploymentConfig): string[][] {
  return [gatekeepersOf(config), ["workshop-backend"], ["router"]];
}

/**
 * Name of the KV namespace or R2 bucket behind one binding. Derived from the worker name, which is
 * a permanent service identity, so a redeploy always resolves to the same storage. An entry in
 * `resources` overrides it -- which is how an existing namespace is adopted.
 */
export function resourceNameFor(
  config: DeploymentConfig, pkgName: string, binding: string,
): { name: string; explicit: boolean } {
  const configured = config.resources[`${pkgName}.${binding}`];
  if (configured) return { name: configured, explicit: true };
  return { name: `${config.workers[pkgName]}-${binding.toLowerCase().replaceAll("_", "-")}`, explicit: false };
}

/** Every KV namespace and R2 bucket the deployment binds, in deploy order. */
export function requiredResources(
  config: DeploymentConfig, baseConfigs: Record<string, WranglerConfig>,
): RequiredResource[] {
  const out: RequiredResource[] = [];
  for (const tier of deploymentTiers(config)) {
    for (const pkgName of tier) {
      const base = baseConfigs[pkgName];
      if (!base) continue;
      for (const kv of base.kv_namespaces ?? []) {
        out.push({ pkgName, binding: kv.binding, kind: "kv", ...resourceNameFor(config, pkgName, kv.binding) });
      }
      for (const r2 of base.r2_buckets ?? []) {
        out.push({ pkgName, binding: r2.binding, kind: "r2", ...resourceNameFor(config, pkgName, r2.binding) });
      }
    }
  }
  return out;
}

/** Secrets one package needs, given what the deployment configures. */
export function requiredSecretsFor(config: DeploymentConfig, pkgName: string): string[] {
  if (pkgName === "workshop-backend") {
    const out: string[] = [];
    if (config.openRouter.enabled) out.push("OPENROUTER_API_KEY");
    // The binding transport covers inference and cost logs in-account, but the model SDK adapter
    // refuses it for google, and it cannot reach a Gateway in another account at all.
    const crossAccount = !!config.aiGateway.accountId && config.aiGateway.accountId !== config.accountId;
    if (config.aiGateway.enabled && (crossAccount || config.aiGateway.providers.includes("google"))) {
      out.push("CF_AI_GATEWAY_API_TOKEN");
    }
    return out;
  }
  if (!pkgName.startsWith(GATEKEEPER_PREFIX)) return [];
  if (pkgName === "gatekeeper-mcp-portal") {
    return config.mcpPortal.auth === "token" ? ["MCP_PORTAL_TOKEN"] : [];
  }
  return GATEKEEPER_SECRETS[pkgName] ?? DEFAULT_GATEKEEPER_SECRETS;
}

/**
 * The non-secret model-catalog vars a deployment describes, as environment variables.
 *
 * Shared with `run-dev-server.ts` so the catalog is stated once and local development inherits it
 * instead of restating it in `.dev.vars`. Deliberately excludes `OPENROUTER_API_KEY`: a deployment
 * description holds no secrets, and a key seeded from a tracked-shaped file is a key nobody
 * remembers is there.
 *
 * Empty when the gateway is disabled, so a caller can seed unconditionally.
 */
export function modelCatalogVars(config: DeploymentConfig): Record<string, string> {
  if (!config.openRouter?.enabled) return {};
  const out: Record<string, string> = {};
  if (config.openRouter.models?.length) out.OPENROUTER_MODELS = config.openRouter.models.join(",");
  if (config.openRouter.quickModel) out.OPENROUTER_QUICK_MODEL = config.openRouter.quickModel;
  if (config.openRouter.baseUrl) out.OPENROUTER_BASE_URL = config.openRouter.baseUrl;
  return out;
}

/** The `sharingDomain` the Context Library namespaces its data by. */
export function sharingDomainOf(config: DeploymentConfig): string {
  return config.context.sharingDomain ?? config.publicBaseUrl;
}

function observabilityOf(config: DeploymentConfig) {
  const { enabled, headSamplingRate, invocationLogs, traces } = config.observability;
  return {
    enabled,
    head_sampling_rate: headSamplingRate,
    logs: { invocation_logs: invocationLogs },
    traces: { enabled: traces.enabled, head_sampling_rate: traces.headSamplingRate },
  };
}

/**
 * Rewrite the service bindings a committed config declares so each names the *deployment's* worker
 * rather than the package. `packages/router/wrangler.jsonc` says `service: "workshop-backend"`;
 * a deployment that named that worker `acme-workshop` needs it to say so.
 */
function retargetServices(services: ServiceBinding[], config: DeploymentConfig): ServiceBinding[] {
  return services.map(svc => ({ ...svc, service: config.workers[svc.service] ?? svc.service }));
}

/**
 * One package's `wrangler.prod.jsonc`. `base` is its committed `wrangler.jsonc`, parsed;
 * `resourceIds` maps `<BINDING>` to the provisioned namespace id or bucket name for this package.
 *
 * Relative paths (`main`, `build`, `assets.directory`) are left exactly as committed: `deploy.ts`
 * runs wrangler with the package directory as its cwd, so they resolve the same way they do for a
 * bare `wrangler deploy`.
 */
export function generateProdConfig(
  pkgName: string,
  base: WranglerConfig,
  config: DeploymentConfig,
  resourceIds: Record<string, string> = {},
): ProdWranglerConfig {
  const workerName = config.workers[pkgName];
  if (!workerName) throw new Error(`${pkgName} is not in this deployment's "workers"`);

  const out: ProdWranglerConfig = {
    ...base,
    name: workerName,
    account_id: config.accountId,
    observability: observabilityOf(config),
  };

  // Committed KV entries carry only `preview_id`, which is dev state; production needs the real id.
  if (base.kv_namespaces) {
    out.kv_namespaces = base.kv_namespaces.map(kv => ({ binding: kv.binding, id: resourceIds[kv.binding] }));
  }
  if (base.r2_buckets) {
    out.r2_buckets = base.r2_buckets.map(r2 => ({ binding: r2.binding, bucket_name: resourceIds[r2.binding] }));
  }
  if (base.services) out.services = retargetServices(base.services, config);

  const vars: Record<string, unknown> = { ...base.vars };

  if (pkgName === "workshop-backend") {
    applyBackendConfig(out, vars, config);
  } else if (pkgName === "router") {
    applyRouterConfig(out, config);
  } else {
    applyGatekeeperConfig(pkgName, out, vars, config);
  }

  if (Object.keys(vars).length > 0) out.vars = vars;
  return out;
}

function applyBackendConfig(
  out: ProdWranglerConfig, vars: Record<string, unknown>, config: DeploymentConfig,
): void {
  vars.PUBLIC_BASE_URL = config.publicBaseUrl;
  // An array rather than a JSON string: a JSON binding is the preferred form, and `ADMINS` accepts
  // either (see workshop-backend/src/env.d.ts).
  vars.ADMINS = config.admins;

  if (config.auth.gatekeepers.length > 0) {
    vars.AUTH_GATEKEEPERS = config.auth.gatekeepers.join(",");
    if (config.auth.disablePassword) vars.DISABLE_PASSWORD_AUTH = "true";
  }

  if (config.aiGateway.enabled) {
    const gatewayAccount = config.aiGateway.accountId ?? config.accountId;
    vars.CF_AI_GATEWAY = config.aiGateway.name;
    vars.CF_AI_GATEWAY_PROVIDERS = config.aiGateway.providers.join(",");
    vars.CF_AI_GATEWAY_ACCOUNT_ID = gatewayAccount;
    // Binding requests are pre-authenticated in-account and cannot cross accounts, and the Worker
    // cannot tell at runtime where the Gateway lives -- so opting out is the deployment's job.
    if (gatewayAccount !== config.accountId) vars.CF_AI_GATEWAY_USE_BINDING = "false";
  }

  if (config.openRouter.enabled) {
    if (config.openRouter.models) vars.OPENROUTER_MODELS = config.openRouter.models.join(",");
    if (config.openRouter.quickModel) vars.OPENROUTER_QUICK_MODEL = config.openRouter.quickModel;
    if (config.openRouter.baseUrl) vars.OPENROUTER_BASE_URL = config.openRouter.baseUrl;
  }

  // Hardcoded rather than read from wrangler.jsonc, exactly as the release manifest does it:
  // webFetch's document-to-Markdown conversion depends on it, and it is the default AI Gateway
  // transport.
  out.ai = { binding: "WORKERS_AI" };

  out.services = [
    ...(out.services ?? []),
    ...gatekeepersOf(config).map(gk => {
      const binding: ServiceBinding = {
        binding: gatekeeperBindingName(gk),
        service: config.workers[gk],
        entrypoint: VENDOR_ENTRYPOINT,
      };
      if (gk === "gatekeeper-context") binding.props = { sharingDomain: sharingDomainOf(config) };
      return binding;
    }),
  ];
}

function applyRouterConfig(out: ProdWranglerConfig, config: DeploymentConfig): void {
  if (config.route.customDomain) {
    out.workers_dev = false;
    out.routes = [{ pattern: config.route.customDomain, custom_domain: true }];
  } else {
    out.workers_dev = true;
  }

  // The default entrypoint, not GatekeeperVendor: the router forwards whole HTTP requests.
  out.services = [
    ...(out.services ?? []),
    ...gatekeepersOf(config).map(gk => ({
      binding: gatekeeperBindingName(gk),
      service: config.workers[gk],
    })),
  ];
}

function applyGatekeeperConfig(
  pkgName: string, out: ProdWranglerConfig, vars: Record<string, unknown>, config: DeploymentConfig,
): void {
  vars.BASE_URL = `${config.publicBaseUrl}/gatekeeper/${gatekeeperShortName(pkgName)}`;

  if (pkgName === "gatekeeper-mcp-portal" && config.mcpPortal.url) {
    vars.MCP_PORTAL_URL = config.mcpPortal.url;
    vars.MCP_PORTAL_AUTH = config.mcpPortal.auth;
    if (config.mcpPortal.name) vars.MCP_PORTAL_NAME = config.mcpPortal.name;
    if (config.mcpPortal.trustAnnotations) vars.MCP_PORTAL_TRUST_ANNOTATIONS = "true";
  }

  if (pkgName === "gatekeeper-context" && config.context.artifacts?.enabled) {
    out.artifacts = { binding: "ARTIFACTS" };
  }
}

/**
 * Parse a `deployment.jsonc`. Trailing commas are accepted because wrangler accepts them and the
 * committed configs in this repo use them -- refusing a file wrangler itself reads happily would
 * be a gratuitous difference.
 */
export function parseJsonc<T>(source: string, path: string): T {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true }) as T;
  if (errors.length > 0) {
    const [first] = errors;
    throw new Error(`${path}: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  if (value === undefined) throw new Error(`${path}: file is empty`);
  return value;
}

/** Read and parse the deployment description at `path`. Applies no defaults and validates nothing. */
export function readDeploymentConfig(path: string): DeploymentConfig {
  return parseJsonc<DeploymentConfig>(readFileSync(path, "utf8"), path);
}

/** Read every deployed package's committed `wrangler.jsonc`, keyed by package name. */
export function readBaseConfigs(root: string, config: DeploymentConfig): Record<string, WranglerConfig> {
  const out: Record<string, WranglerConfig> = {};
  for (const pkgName of Object.keys(config.workers)) {
    out[pkgName] = readWranglerConfig(join(root, PACKAGES_DIR, pkgName));
  }
  return out;
}

/**
 * Every reason this deployment cannot be deployed, as human-readable lines. Empty means valid.
 *
 * Reported all at once rather than thrown one at a time: filling in a deployment description is a
 * single sitting, and a validator that surfaces one field per run turns it into ten.
 */
export function validateDeployment(config: DeploymentConfig, root: string): string[] {
  const errors: string[] = [];
  const missing = (path: string) => errors.push(`${path} is required`);

  if (!config.accountId) missing("accountId");
  else if (!ACCOUNT_ID_PATTERN.test(config.accountId)) {
    errors.push(`accountId must be 32 hex characters, got "${config.accountId}"`);
  }

  if (!config.publicBaseUrl) missing("publicBaseUrl");
  else if (!ORIGIN_PATTERN.test(config.publicBaseUrl)) {
    errors.push(
      `publicBaseUrl must be a bare https origin with no path and no trailing slash, ` +
      `got "${config.publicBaseUrl}"`);
  }

  if (!config.route || (!config.route.workersDev && !config.route.customDomain)) {
    errors.push('route must be {"workersDev": true} or {"customDomain": "<hostname>"}');
  } else if (config.route.customDomain && config.publicBaseUrl &&
      config.publicBaseUrl !== `https://${config.route.customDomain}`) {
    // Both are load-bearing and they cannot disagree: one is what wrangler publishes the router
    // on, the other is what every OAuth redirect URI is built from.
    errors.push(
      `publicBaseUrl ("${config.publicBaseUrl}") does not match route.customDomain ` +
      `("${config.route.customDomain}")`);
  }

  if (!config.admins?.length) errors.push("admins must list at least one identity");

  errors.push(...validateWorkers(config, root));
  errors.push(...validateAuth(config));
  errors.push(...validateGateways(config));
  errors.push(...validateResources(config));

  if (!config.observability) missing("observability");
  return errors;
}

function validateWorkers(config: DeploymentConfig, root: string): string[] {
  const errors: string[] = [];
  const names = Object.entries(config.workers ?? {});
  if (names.length === 0) return ["workers must name at least the router and the backend"];

  for (const pkgName of REQUIRED_PACKAGES) {
    if (!config.workers[pkgName]) errors.push(`workers."${pkgName}" is required`);
  }

  for (const [pkgName, workerName] of names) {
    if (pkgName !== "router" && pkgName !== "workshop-backend" &&
        !pkgName.startsWith(GATEKEEPER_PREFIX)) {
      errors.push(`workers."${pkgName}" is not a deployable package`);
      continue;
    }
    try {
      readWranglerConfig(join(root, PACKAGES_DIR, pkgName));
    } catch {
      errors.push(`workers."${pkgName}" has no packages/${pkgName}/wrangler.jsonc in this checkout`);
    }
    if (!workerName) errors.push(`workers."${pkgName}" must name a worker`);
    else if (!/^[a-z\d][a-z\d-]{0,62}$/.test(workerName)) {
      errors.push(
        `workers."${pkgName}" = "${workerName}" is not a valid worker name ` +
        "(lowercase letters, digits and hyphens; must not start with a hyphen)");
    }
  }

  const duplicates = names.map(([, name]) => name)
      .filter((name, i, all) => all.indexOf(name) !== i);
  for (const name of new Set(duplicates)) {
    errors.push(`worker name "${name}" is used more than once; each must be unique in the account`);
  }
  return errors;
}

function validateAuth(config: DeploymentConfig): string[] {
  const errors: string[] = [];
  if (!config.auth) return ["auth is required"];

  const deployed = new Set(gatekeepersOf(config).map(gatekeeperShortName));
  for (const vendor of config.auth.gatekeepers ?? []) {
    if (!deployed.has(vendor)) {
      errors.push(
        `auth.gatekeepers lists "${vendor}", but workers has no "gatekeeper-${vendor}" -- ` +
        "a gatekeeper cannot drive sign-in unless it is deployed");
    }
  }
  // Not an error, because the backend refuses to honour it in this state rather than locking
  // everyone out -- but silently ignoring what the config asked for deserves a word.
  if (config.auth.disablePassword && !config.auth.gatekeepers?.length) {
    errors.push(
      "auth.disablePassword is set with no auth.gatekeepers, which would leave no way to sign in; " +
      "the backend ignores it in this state, so either list a gatekeeper or clear the flag");
  }
  return errors;
}

function validateGateways(config: DeploymentConfig): string[] {
  const errors: string[] = [];
  if (!config.aiGateway) return ["aiGateway is required"];
  if (config.aiGateway.enabled) {
    if (!config.aiGateway.name) errors.push("aiGateway.name is required when aiGateway.enabled");
    if (!config.aiGateway.providers?.length) {
      errors.push("aiGateway.providers must list at least one provider when aiGateway.enabled");
    }
    for (const provider of config.aiGateway.providers ?? []) {
      if (!(AI_GATEWAY_PROVIDERS as readonly string[]).includes(provider)) {
        errors.push(
          `aiGateway.providers contains "${provider}"; supported: ${AI_GATEWAY_PROVIDERS.join(", ")}`);
      }
    }
  }
  if (!config.openRouter) errors.push("openRouter is required (set enabled: false to leave it off)");
  // Both are read unconditionally when their gatekeeper is generated, so the objects must exist
  // even for a deployment that configures neither.
  if (!config.mcpPortal) errors.push("mcpPortal is required (use nulls to leave the portal unconfigured)");
  if (!config.context) errors.push("context is required (use nulls for the defaults)");

  if (config.workers?.["gatekeeper-mcp-portal"] && !config.mcpPortal?.url) {
    errors.push(
      'workers includes "gatekeeper-mcp-portal" but mcpPortal.url is unset, so the connector ' +
      "would advertise no resources and stay hidden");
  }
  return errors;
}

function validateResources(config: DeploymentConfig): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(config.resources ?? {})) {
    const [pkgName, binding] = key.split(".");
    if (!binding) {
      errors.push(`resources."${key}" must be spelled "<package>.<BINDING>"`);
      continue;
    }
    if (!config.workers?.[pkgName]) {
      errors.push(`resources."${key}" names package "${pkgName}", which is not deployed`);
    }
    if (value !== null && typeof value !== "string") {
      errors.push(`resources."${key}" must be a string or null`);
    }
  }
  return errors;
}
