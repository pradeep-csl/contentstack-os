#!/usr/bin/env node

// Deploys this checkout into one Cloudflare account you own, as described by `deployment.jsonc`.
//
//   node scripts/deploy/deploy.ts --check        validate + generate configs, touch no network
//   node scripts/deploy/deploy.ts                build, provision, deploy every worker
//   node scripts/deploy/deploy.ts --secrets      upload secrets from .deploy.vars, deploy nothing
//   node scripts/deploy/deploy.ts --only <pkg>   redeploy one worker (skips provisioning of others)
//   node scripts/deploy/deploy.ts --skip-build   reuse the build outputs already on disk
//
// The account is pinned three ways over, so an ambient `wrangler login` for a different account
// cannot be the one that gets deployed to: `account_id` is written into every generated config,
// `CLOUDFLARE_ACCOUNT_ID` is set in each child process, and the API token supplied through
// `CLOUDFLARE_API_TOKEN` is expected to be scoped to that account alone.
//
// Deployment runs in three tiers, because each tier's service bindings must name what the tier
// before it produced -- see `deploymentTiers`. Tiers are sequential; within a tier the workers are
// independent, but they are still deployed one at a time: Wrangler prints a lot, and interleaved
// output from a failing deploy is worse than a slower run.
//
// Secrets never enter a generated config. Wrangler prints config values, and these configs are
// build output that a support transcript or a CI log can easily end up carrying. They are uploaded
// separately with `wrangler secret put`, reading `.deploy.vars` (gitignored) over stdin.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WranglerConfig } from "../release/manifest-lib.ts";
import { resolveBinEntry } from "../bin-entry.ts";
import { pnpmCommand } from "../pnpm-command.ts";
import {
  DEPLOYMENT_CONFIG_NAME,
  PACKAGES_DIR,
  PROD_CONFIG_NAME,
  deploymentTiers,
  gatekeepersOf,
  assertOnlyRouterIsPublic,
  generateProdConfig,
  readBaseConfigs,
  readDeploymentConfig,
  requiredResources,
  requiredSecretsFor,
  sharingDomainOf,
  validateDeployment,
  type DeploymentConfig,
  type ProdWranglerConfig,
  type RequiredResource,
} from "./deployment-config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SECRETS_FILE = ".deploy.vars";
const USAGE =
  "Usage: deploy.ts [--check] [--secrets] [--only <package>] [--skip-build] [--config <path>]";

/** What one invocation was asked to do. */
interface Options {
  /** Validate and generate only; make no network calls and deploy nothing. */
  check: boolean;
  /** Upload secrets from `.deploy.vars` instead of deploying. */
  secretsOnly: boolean;
  /** Restrict the deploy to one package, for iterating on a single worker. */
  only: string | null;
  /** Trust the build outputs already on disk. */
  skipBuild: boolean;
  /** Path to the deployment description. */
  configPath: string;
}

/** A finished child process. */
interface Result {
  /** Exit code, or null when a signal killed it. */
  status: number | null;
  /** Captured stdout, when the caller asked for it. */
  stdout: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    check: false,
    secretsOnly: false,
    only: null,
    skipBuild: false,
    configPath: join(ROOT, DEPLOYMENT_CONFIG_NAME),
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--check": options.check = true; break;
      case "--secrets": options.secretsOnly = true; break;
      case "--skip-build": options.skipBuild = true; break;
      case "--only": {
        const value = argv[++i];
        if (!value) throw new Error(`--only needs a package name\n${USAGE}`);
        options.only = value;
        break;
      }
      case "--config": {
        const value = argv[++i];
        if (!value) throw new Error(`--config needs a path\n${USAGE}`);
        options.configPath = resolve(value);
        break;
      }
      default: throw new Error(`unknown argument: ${argv[i]}\n${USAGE}`);
    }
  }
  return options;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/**
 * Run a command, inheriting stdio unless `capture`, and fail the deploy if it does not exit zero.
 * `CLOUDFLARE_ACCOUNT_ID` is injected for every child: the generated configs pin the account for
 * `wrangler deploy`, but `wrangler secret put` and the provisioning commands take no config.
 */
function run(
  command: string, args: string[],
  { cwd = ROOT, accountId, capture = false, input, label = `${command} ${args.join(" ")}` }:
    { cwd?: string; accountId?: string; capture?: boolean; input?: string; label?: string } = {},
): Result {
  if (!capture) console.log(`\n$ ${label}`);
  const child = spawnSync(command, args, {
    cwd,
    stdio: capture ? ["pipe", "pipe", "inherit"] : (input === undefined ? "inherit" : ["pipe", "inherit", "inherit"]),
    input,
    encoding: "utf8",
    env: accountId ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } : process.env,
  });
  if (child.error) fail(`${label} could not be started: ${child.error.message}`);
  return { status: child.status, stdout: child.stdout ?? "" };
}

/** Run a command and fail the deploy unless it exits zero. */
function runOrFail(command: string, args: string[], options: Parameters<typeof run>[2] = {}): Result {
  const result = run(command, args, options);
  if (result.status !== 0) {
    fail(`${options.label ?? `${command} ${args.join(" ")}`} failed with exit code ${result.status}`);
  }
  return result;
}

/** Invoke wrangler, reached as `node <entry>` where possible and through `pnpm exec` otherwise. */
function wrangler(
  args: string[], options: { cwd?: string; accountId: string; capture?: boolean; input?: string },
): Result {
  const cwd = options.cwd ?? ROOT;
  const entry = resolveBinEntry(cwd, "wrangler") ?? resolveBinEntry(ROOT, "wrangler");
  const [command, argv] = entry
    ? [process.execPath, [entry, ...args]]
    : pnpmCommand(["exec", "wrangler", ...args]);
  return run(command, argv, { ...options, cwd, label: `wrangler ${args.join(" ")}` });
}

/** Run a workspace task through `vp`, never from cache -- a deploy must not replay a stale artifact. */
function vp(args: string[]): void {
  const [command, argv] = pnpmCommand(["exec", "vp", ...args]);
  runOrFail(command, argv, { label: `vp ${args.join(" ")}` });
}

// ---------------------------------------------------------------------------
// Pre-flight builds.
// ---------------------------------------------------------------------------

/**
 * Everything wrangler cannot produce for itself. Each worker's own bundle is built by the
 * `build.command` in its config, which wrangler runs, but three kinds of input are generated
 * outside that: the backend's bundled format blueprints, each gatekeeper's UI, and the frontend
 * bundle the router serves as static assets.
 *
 * Uncached throughout. A cache hit is only as good as its fingerprint, which is cheap to absorb on
 * a build you can re-run and expensive on a deploy you cannot.
 */
function preflightBuilds(): void {
  console.log("\n=== building deploy inputs ===");

  // Runs with the package as its cwd: the generator resolves `format-blueprints/` and its output
  // path relative to the directory it is invoked from, not to the script's own location.
  const backendDir = join(ROOT, PACKAGES_DIR, "workshop-backend");
  runOrFail(process.execPath, [join(backendDir, "scripts", "build-format-blueprints.mjs")],
      { cwd: backendDir, label: "build format blueprints" });

  // Gatekeeper UIs: the configurator modules and the single-file management apps. Selected by
  // which packages declare the task, so a newly deployed gatekeeper needs no change here.
  vp(["run", "-r", "--no-cache", "build:configurator"]);
  vp(["run", "-r", "--no-cache", "build:app"]);

  // The router serves `packages/workshop-frontend/dist`, so this must precede its deploy.
  vp(["run", "--filter", "@gadgets/workshop-frontend", "--no-cache", "build"]);

  const dist = join(ROOT, PACKAGES_DIR, "workshop-frontend", "dist", "index.html");
  if (!existsSync(dist)) fail(`the frontend build produced no ${dist}; the router has nothing to serve`);
}

// ---------------------------------------------------------------------------
// Origin check.
// ---------------------------------------------------------------------------

/**
 * On a workers.dev deployment, confirm `publicBaseUrl` names the origin the router will actually
 * answer on.
 *
 * `--check` cannot do this -- the account's workers.dev subdomain is not derivable from any file,
 * only from the API -- and getting it wrong is close to the worst outcome the harness has: the
 * deploy succeeds, and every worker is baked with OAuth redirect URIs pointing at a hostname that
 * does not exist, plus a `sharingDomain` that no later deploy can reproduce without being told the
 * old value. So this runs on the deploy path, before anything is created.
 *
 * A failed lookup is not a failed check: being unable to verify is not the same as verifying a
 * mismatch, so it warns and continues.
 */
async function assertOriginMatchesAccount(config: DeploymentConfig): Promise<void> {
  if (!config.route.workersDev) return;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return;

  let subdomain: string | undefined;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/subdomain`,
      { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json() as { result?: { subdomain?: string } };
    subdomain = body.result?.subdomain;
  } catch (err) {
    console.warn(`could not read the account's workers.dev subdomain: ${(err as Error).message}`);
    return;
  }
  if (!subdomain) {
    console.warn("could not read the account's workers.dev subdomain; skipping the origin check");
    return;
  }

  const expected = `https://${config.workers.router}.${subdomain}.workers.dev`;
  if (config.publicBaseUrl !== expected) {
    fail(
      `publicBaseUrl is "${config.publicBaseUrl}", but this account's router will answer on\n` +
      `  ${expected}\n` +
      `(account ${config.accountId}, workers.dev subdomain "${subdomain}").\n\n` +
      "Deploying anyway would bake a hostname that does not exist into every OAuth redirect URI " +
      "and into the Context Library's sharingDomain. Fix publicBaseUrl, or rename the router " +
      "worker, or change the account's workers.dev subdomain in the dashboard -- which also " +
      "moves every other worker in the account.");
  }
  console.log(`origin verified: ${expected}`);
}

// ---------------------------------------------------------------------------
// Storage provisioning.
// ---------------------------------------------------------------------------

/**
 * Ensure every KV namespace and R2 bucket exists, and return the ids the generated configs bind.
 *
 * Provisioned explicitly rather than through wrangler's automatic provisioning, which writes the
 * ids it invents back into the config file it read. These configs are regenerated on every run, so
 * that write-back would be discarded -- and the next deploy would provision *new*, empty storage
 * and bind the workers to it. Naming the resources ourselves makes a redeploy idempotent.
 */
function provisionResources(
  config: DeploymentConfig, resources: RequiredResource[],
): Record<string, Record<string, string>> {
  const ids: Record<string, Record<string, string>> = {};
  if (resources.length === 0) return ids;

  console.log("\n=== provisioning storage ===");
  const kvNamespaces = listKvNamespaces(config.accountId);

  for (const resource of resources) {
    (ids[resource.pkgName] ??= {});
    if (resource.kind === "kv") {
      const existing = kvNamespaces.get(resource.name);
      if (existing) {
        console.log(`  kv  ${resource.name} -> ${existing} (existing)`);
        ids[resource.pkgName][resource.binding] = existing;
        continue;
      }
      if (resource.explicit) {
        fail(
          `resources."${resource.pkgName}.${resource.binding}" names KV namespace ` +
          `"${resource.name}", which does not exist in account ${config.accountId}. An explicit ` +
          "name is treated as an existing namespace to adopt, never created -- creating one would " +
          "silently give the worker empty storage. Create it, or clear the entry to have a " +
          "namespace provisioned.");
      }
      ids[resource.pkgName][resource.binding] = createKvNamespace(config.accountId, resource.name);
    } else {
      ensureR2Bucket(config.accountId, resource);
      // R2 bindings name the bucket; there is no separate id to resolve.
      ids[resource.pkgName][resource.binding] = resource.name;
    }
  }
  return ids;
}

/** Every KV namespace in the account, as title -> id. */
function listKvNamespaces(accountId: string): Map<string, string> {
  const result = wrangler(["kv", "namespace", "list"], { accountId, capture: true });
  if (result.status !== 0) {
    fail(
      "could not list KV namespaces. Check that CLOUDFLARE_API_TOKEN is set and carries " +
      `"Workers KV Storage: Edit" on account ${accountId}.`);
  }
  // Wrangler prints a JSON array, sometimes preceded by banner lines.
  const start = result.stdout.indexOf("[");
  if (start === -1) fail(`could not parse the KV namespace list:\n${result.stdout}`);
  const parsed = JSON.parse(result.stdout.slice(start)) as { id: string; title: string }[];
  return new Map(parsed.map(ns => [ns.title, ns.id]));
}

/**
 * Create a KV namespace and return its id.
 *
 * The id is recovered by listing the namespaces again rather than by parsing it out of the create
 * command's output. `create` prints a human-readable summary whose wording is not a contract, and
 * the failure mode of misreading it is the worst one available here: a worker bound to storage that
 * is not the namespace just created. The extra list call costs one request, once per resource.
 */
function createKvNamespace(accountId: string, title: string): string {
  const result = wrangler(["kv", "namespace", "create", title], { accountId, capture: true });
  if (result.status !== 0) {
    fail(
      `could not create KV namespace "${title}". Check that CLOUDFLARE_API_TOKEN carries ` +
      `"Workers KV Storage: Edit" on account ${accountId}.`);
  }
  const id = listKvNamespaces(accountId).get(title);
  if (!id) {
    fail(
      `created KV namespace "${title}", but it is not in the account's namespace list. Refusing ` +
      "to continue: deploying now would let wrangler bind some other namespace instead.");
  }
  console.log(`  kv  ${title} -> ${id} (created)`);
  return id;
}

function ensureR2Bucket(accountId: string, resource: RequiredResource): void {
  const info = wrangler(["r2", "bucket", "info", resource.name], { accountId, capture: true });
  if (info.status === 0) {
    console.log(`  r2  ${resource.name} (existing)`);
    return;
  }
  if (resource.explicit) {
    fail(
      `resources."${resource.pkgName}.${resource.binding}" names R2 bucket "${resource.name}", ` +
      `which does not exist in account ${accountId}. An explicit name is treated as an existing ` +
      "bucket to adopt, never created. Create it, or clear the entry to have one provisioned.");
  }
  const created = wrangler(["r2", "bucket", "create", resource.name], { accountId, capture: true });
  if (created.status !== 0) {
    fail(
      `could not create R2 bucket "${resource.name}". Check that CLOUDFLARE_API_TOKEN carries ` +
      `"Workers R2 Storage: Edit" on account ${accountId}, and that R2 is enabled.`);
  }
  console.log(`  r2  ${resource.name} (created)`);
}

// ---------------------------------------------------------------------------
// Config generation and deployment.
// ---------------------------------------------------------------------------

/**
 * Write every deployed package's `wrangler.prod.jsonc` and return the paths written.
 *
 * `requireResolved` is the guard on the deploy path: a KV or R2 binding whose id did not survive
 * provisioning would serialise as a bare `{ "binding": ... }`, which is precisely wrangler's
 * automatic-provisioning form. Wrangler would then invent a resource, bind the worker to it, and
 * write the id back into a file the next run regenerates -- so the deploy after this one would
 * quietly bind a second, empty namespace. Failing here is the only safe outcome.
 */
function writeProdConfigs(
  config: DeploymentConfig,
  baseConfigs: Record<string, WranglerConfig>,
  resourceIds: Record<string, Record<string, string>>,
  requireResolved: boolean,
): string[] {
  const written: string[] = [];
  const generatedAll: Record<string, ProdWranglerConfig> = {};
  for (const pkgName of Object.keys(config.workers)) {
    const generated = generateProdConfig(pkgName, baseConfigs[pkgName], config, resourceIds[pkgName]);
    generatedAll[pkgName] = generated;
    if (requireResolved) {
      for (const binding of [...(generated.kv_namespaces ?? []), ...(generated.r2_buckets ?? [])]) {
        const resolved = (binding as { id?: string; bucket_name?: string });
        if (!resolved.id && !resolved.bucket_name) {
          fail(
            `${pkgName}'s ${binding.binding} binding has no provisioned resource. Deploying it ` +
            "would let wrangler provision one implicitly and bind the next deploy to different, " +
            "empty storage. This is a bug in provisioning, not something to work around.");
        }
      }
    }
    const path = join(ROOT, PACKAGES_DIR, pkgName, PROD_CONFIG_NAME);
    writeFileSync(path, JSON.stringify(generated, null, 2) + "\n");
    written.push(path);
  }

  // Checked over the whole set rather than per worker: the invariant is about which *one* of them
  // is public, which no single config can establish on its own.
  try {
    assertOnlyRouterIsPublic(generatedAll);
  } catch (err) {
    fail((err as Error).message);
  }
  return written;
}

/**
 * After deploying, confirm the account agrees that only the router answers on workers.dev.
 *
 * The generated configs are checked before the deploy, but they are not the authority -- a worker
 * that already existed with its subdomain enabled, or one enabled by hand in the dashboard, is
 * exposed regardless of what this run asked for. So the property is verified where it actually
 * lives. Reported loudly rather than fixed: silently disabling a route somebody enabled on purpose
 * would be its own surprise.
 */
async function verifyOnlyRouterIsPublic(config: DeploymentConfig, packages: string[]): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return;
  console.log("\n=== verifying only the router is publicly reachable ===");

  const exposed: string[] = [];
  for (const pkgName of packages) {
    if (pkgName === "router") continue;
    const workerName = config.workers[pkgName];
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.accountId}` +
        `/workers/scripts/${workerName}/subdomain`,
        { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json() as { result?: { enabled?: boolean } };
      if (body.result?.enabled) exposed.push(`  ${workerName} answers on workers.dev`);
      else console.log(`  ${workerName}: not publicly reachable`);
    } catch (err) {
      console.warn(`  ${workerName}: could not verify (${(err as Error).message})`);
    }
  }

  if (exposed.length > 0) {
    fail(
      "these workers are reachable from the internet, bypassing the router:\n" +
      exposed.join("\n") +
      "\n\nDisable their workers.dev route in the dashboard (Settings -> Domains & Routes). The " +
      "backend's RPC API and each gatekeeper's OAuth flow are meant to be reachable only over a " +
      "service binding.");
  }
}

/** Deploy one worker from its generated config, with the package directory as wrangler's cwd. */
function deployWorker(config: DeploymentConfig, pkgName: string): void {
  const cwd = join(ROOT, PACKAGES_DIR, pkgName);
  const result = wrangler(["deploy", "--config", PROD_CONFIG_NAME], {
    cwd, accountId: config.accountId,
  });
  if (result.status !== 0) {
    fail(`deploying ${pkgName} as "${config.workers[pkgName]}" failed with exit code ${result.status}`);
  }
}

// ---------------------------------------------------------------------------
// Secrets.
// ---------------------------------------------------------------------------

/**
 * Read `.deploy.vars`: `KEY=VALUE` per line, `#` comments, optional surrounding quotes. Same shape
 * as the `.dev.vars` file `run-dev-server.ts` loads, and gitignored for the same reason.
 *
 * Deliberately the only source of secrets. Reading them from the environment instead would put
 * every deploy one exported variable away from uploading a stale credential without saying so.
 */
function readSecretsFile(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out.set(key, value);
  }
  return out;
}

/**
 * The `.deploy.vars` key one worker's secret is read from. Secrets are per-Worker, so the file
 * qualifies each by package -- `GATEKEEPER_GITHUB_CLIENT_SECRET`, not a global `CLIENT_SECRET`
 * that two gatekeepers would silently share.
 */
function secretsFileKey(pkgName: string, secret: string): string {
  return pkgName === "workshop-backend"
    ? secret
    : `${pkgName.toUpperCase().replaceAll("-", "_")}_${secret}`;
}

/** Upload every secret `.deploy.vars` supplies, and report the ones it does not. */
function uploadSecrets(config: DeploymentConfig, packages: string[]): void {
  const supplied = readSecretsFile(join(ROOT, SECRETS_FILE));
  console.log(`\n=== secrets (from ${SECRETS_FILE}) ===`);
  if (supplied.size === 0) console.log(`  no ${SECRETS_FILE} found, or it is empty`);

  const missing: string[] = [];
  for (const pkgName of packages) {
    for (const secret of requiredSecretsFor(config, pkgName)) {
      const key = secretsFileKey(pkgName, secret);
      const value = supplied.get(key);
      if (value === undefined || value === "") {
        missing.push(`  ${key}  ->  ${config.workers[pkgName]} / ${secret}`);
        continue;
      }
      const result = wrangler(
        ["secret", "put", secret, "--name", config.workers[pkgName]],
        { accountId: config.accountId, input: value });
      if (result.status !== 0) {
        fail(`could not set ${secret} on ${config.workers[pkgName]}`);
      }
      console.log(`  set ${secret} on ${config.workers[pkgName]}`);
    }
  }

  if (missing.length > 0) {
    console.log(
      `\nnot supplied -- add these to ${SECRETS_FILE} and re-run with --secrets. Until then the ` +
      "affected connector cannot complete an OAuth flow:");
    console.log(missing.join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function printPlan(
  config: DeploymentConfig, resources: RequiredResource[], packages: string[],
): void {
  console.log("\n=== deployment plan ===");
  console.log(`  account       ${config.accountId}`);
  console.log(`  origin        ${config.publicBaseUrl}`);
  console.log(`  route         ${config.route.customDomain ?? "workers.dev"}`);
  console.log(`  admins        ${config.admins.join(", ")}`);
  console.log(`  sign-in       ${signInSummary(config)}`);
  console.log(`  models        ${modelSummary(config)}`);
  console.log(`  sharingDomain ${sharingDomainOf(config)}`);

  console.log("\n  workers, by deploy tier:");
  for (const [tier, members] of deploymentTiers(config).entries()) {
    const included = members.filter(pkgName => packages.includes(pkgName));
    if (included.length === 0) continue;
    console.log(`    tier ${tier + 1}:`);
    for (const pkgName of included) {
      console.log(`      ${pkgName.padEnd(24)} -> ${config.workers[pkgName]}`);
    }
  }

  if (resources.length > 0) {
    console.log("\n  storage:");
    for (const r of resources) {
      const origin = r.explicit ? "adopt existing" : "provision if absent";
      console.log(`    ${r.kind}  ${r.name.padEnd(40)} ${r.pkgName}/${r.binding}  (${origin})`);
    }
  }

  const secrets = packages.flatMap(pkgName =>
    requiredSecretsFor(config, pkgName).map(secret => `    ${secretsFileKey(pkgName, secret)}`));
  if (secrets.length > 0) {
    console.log(`\n  secrets expected in ${SECRETS_FILE}:`);
    console.log(secrets.join("\n"));
  }
}

function signInSummary(config: DeploymentConfig): string {
  const parts: string[] = [];
  if (config.auth.gatekeepers.length > 0) parts.push(`gatekeepers: ${config.auth.gatekeepers.join(", ")}`);
  parts.push(config.auth.disablePassword && config.auth.gatekeepers.length > 0
    ? "password accounts disabled" : "password accounts enabled");
  return parts.join("; ");
}

function modelSummary(config: DeploymentConfig): string {
  const parts: string[] = [];
  if (config.aiGateway.enabled) {
    parts.push(`AI Gateway "${config.aiGateway.name}" (${config.aiGateway.providers.join(", ")})`);
  }
  if (config.openRouter.enabled) parts.push("OpenRouter");
  return parts.length > 0 ? parts.join(" + ") : "bring your own key";
}

function printRedirectUris(config: DeploymentConfig, packages: string[]): void {
  const oauthGatekeepers = packages
      .filter(pkgName => requiredSecretsFor(config, pkgName).includes("CLIENT_ID"));
  if (oauthGatekeepers.length === 0) return;
  console.log("\n=== OAuth redirect URIs to register with each provider ===");
  for (const pkgName of oauthGatekeepers) {
    const short = pkgName.slice("gatekeeper-".length);
    console.log(`  ${short.padEnd(12)} ${config.publicBaseUrl}/gatekeeper/${short}/oauth`);
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

let options: Options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  fail((err as Error).message);
}

if (!existsSync(options.configPath)) {
  fail(
    `no deployment description at ${options.configPath}.\n` +
    `Copy deployment.example.jsonc to ${DEPLOYMENT_CONFIG_NAME} and fill it in ` +
    "(see docs/self-hosting.md).");
}

const config = readDeploymentConfig(options.configPath);
const errors = validateDeployment(config, ROOT);
if (errors.length > 0) {
  fail(`${options.configPath} is not deployable:\n${errors.map(e => `  - ${e}`).join("\n")}`);
}

if (options.only && !config.workers[options.only]) {
  fail(`--only ${options.only}: not in this deployment's "workers"`);
}

const allPackages = deploymentTiers(config).flat();
const packages = options.only ? [options.only] : allPackages;
const baseConfigs = readBaseConfigs(ROOT, config);
const resources = requiredResources(config, baseConfigs)
    .filter(resource => packages.includes(resource.pkgName));

if (options.secretsOnly) {
  uploadSecrets(config, packages);
  console.log("");
  process.exit(0);
}

printPlan(config, resources, packages);

if (options.check) {
  // Generated with no resource ids: `--check` makes no network calls, so it cannot know them. The
  // configs it writes are for reading, not deploying -- a real run overwrites them.
  const written = writeProdConfigs(config, baseConfigs, {}, false);
  console.log("\n=== generated (bindings unresolved; --check makes no API calls) ===");
  for (const path of written) console.log(`  ${path.slice(ROOT.length + 1)}`);
  console.log("\ndeployment.jsonc is valid. Run without --check to deploy.\n");
  process.exit(0);
}

await assertOriginMatchesAccount(config);

if (!options.skipBuild) preflightBuilds();

const resourceIds = provisionResources(config, resources);
writeProdConfigs(config, baseConfigs, resourceIds, true);

console.log("\n=== deploying ===");
for (const tier of deploymentTiers(config)) {
  for (const pkgName of tier) {
    if (!packages.includes(pkgName)) continue;
    deployWorker(config, pkgName);
  }
}

uploadSecrets(config, packages);
await verifyOnlyRouterIsPublic(config, packages);
printRedirectUris(config, packages);

console.log(`\nDeployed. Open ${config.publicBaseUrl}`);
if (config.route.workersDev) {
  console.log(
    `If that 404s, confirm the router's workers.dev hostname in the dashboard and make sure ` +
    `publicBaseUrl matches it -- OAuth redirects and Context data scoping both depend on it.`);
}
console.log(`Admin panel: ${config.publicBaseUrl}/admin (as ${config.admins.join(", ")})`);
const gatekeeperCount = gatekeepersOf(config).length;
console.log(`Gatekeepers deployed: ${gatekeeperCount}\n`);
