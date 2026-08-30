// The fork-intent ratchet: every way this fork deliberately differs from cloudflare/cloudflare-os,
// asserted so an upstream merge cannot quietly undo it.
//
// Why this exists. A conflict is the *safe* case -- git stops and asks. The dangerous case is a file
// upstream changed and the fork did not, which auto-merges cleanly and silently reverts fork intent.
// The 2026-08-20 merge had four of those, none of which failed anything: DEFAULT_SITE_NAME reverted
// to "Cloudflare OS", the two design ratchets stopped being run, the Context Library's workerd suite
// was orphaned, and ChatInterface's `surface` prop lost its only use.
//
// How to use it. Each assertion carries a stable id (F1.1, F2.3, ...) that `docs/fork-delta.md`
// references, so the ledger and the enforcement cannot drift apart.
//
//  - Adding fork behaviour worth defending: add an entry here AND a row in docs/fork-delta.md.
//  - Upstream needs to displace fork behaviour: do NOT just delete the assertion. Follow the cede
//    protocol in docs/upstream-merge-runbook.md -- move the row to the Ceded table with a reason and
//    the upstream commit, and delete the assertion in that same commit, so the trade is visible in
//    the pull request diff rather than lost.
//
// The point is not that the fork always wins. It is that the fork never loses by accident.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** One thing the fork means to be true, and the check that proves it still is. */
type Intent = {
  /** Stable id referenced by docs/fork-delta.md. Never reuse an id after ceding it. */
  id: string
  /** What the fork means to be true, in the terms a reviewer would use. */
  intent: string
  /** True while the fork's intent still holds. */
  holds: () => boolean
}

const read = (repoRelative: string) => readFileSync(join(ROOT, repoRelative), 'utf8')
const has = (repoRelative: string) => existsSync(join(ROOT, repoRelative))

/** Whether `pattern` appears in the file, treating a missing file as a failure rather than a throw. */
function matches(repoRelative: string, pattern: RegExp): boolean {
  return has(repoRelative) && pattern.test(read(repoRelative))
}

/** How many files under `dir` contain `pattern`; the floor form of an erosion guard. */
function fileCount(dir: string, pattern: RegExp): number {
  let count = 0
  const walk = (current: string) => {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx|css)$/.test(entry.name) && pattern.test(readFileSync(full, 'utf8'))) count++
    }
  }
  walk(join(ROOT, dir))
  return count
}

const INTENTS: Intent[] = [
  // ---- F1  OpenRouter as a peer gateway to the Cloudflare AI Gateway --------------------------
  { id: 'F1.1', intent: 'the ModelGateway registry abstracts over gateways',
    holds: () => matches('packages/workshop-backend/src/ai-gateway.ts', /\bModelGateway\b/) },
  { id: 'F1.2', intent: 'the Cloudflare gateway is one implementation, not the only one',
    holds: () => matches('packages/workshop-backend/src/ai-gateway.ts', /class CloudflareModelGateway/) },
  { id: 'F1.3', intent: 'openrouter is a first-class AiModelProvider on the RPC API',
    holds: () => matches('packages/workshop-shared/src/api.ts', /"openrouter"/) },
  { id: 'F1.4', intent: 'AiGatewayId and the gateways list are on the RPC API',
    holds: () => matches('packages/workshop-shared/src/api.ts', /export type AiGatewayId/)
              && matches('packages/workshop-shared/src/api.ts', /gateways: \{ id: AiGatewayId/) },
  { id: 'F1.5', intent: 'listModels() returns gateway-tagged profiles, not bare authors',
    holds: () => matches('packages/workshop-shared/src/api.ts', /export type AiModelInfo/)
              && matches('packages/workshop-shared/src/api.ts', /gateway\?: AiGatewayId/) },
  { id: 'F1.6', intent: 'the openrouter catalog ships with the deployment',
    holds: () => matches('packages/workshop-shared/src/api.ts', /"openrouter": \{/) },
  { id: 'F1.7', intent: 'a user with no gateway still gets quick tasks, using their own model',
    holds: () => matches('packages/workshop-backend/src/user.ts', /#defaultQuickModel/) },
  { id: 'F1.8', intent: 'the dev server passes the OpenRouter credentials through',
    holds: () => matches('scripts/run-dev-server.ts', /OPENROUTER_API_KEY/)
              && matches('.env.example', /OPENROUTER_API_KEY/) },
  { id: 'F1.9', intent: 'the model pickers show and search on the serving gateway',
    holds: () => has('packages/workshop-frontend/src/modelListDisplay.ts')
              && has('packages/workshop-frontend/src/suggestedModelMatch.ts')
              && has('packages/workshop-frontend/src/AddModelModal.tsx') },

  // ---- F2  Contentstack identity on the Venus palette ----------------------------------------
  { id: 'F2.1', intent: 'the product is named Contentstack OS, including in prose',
    holds: () => matches('packages/workshop-shared/src/api.ts', /DEFAULT_SITE_NAME = "Contentstack OS"/)
              && !matches('packages/workshop-shared/src/api.ts', /Cloudflare OS/)
              && matches('README.md', /Contentstack OS/) },
  { id: 'F2.2', intent: 'design tokens are a shared package, not copied per app',
    holds: () => has('packages/design-tokens/tokens.css') && has('packages/design-tokens/package.json') },
  // Pinned to the exact Venus value, which is a stronger statement than "not the old orange" --
  // and naming the old hex here would trip legacy-palette.test.ts, which bans it repo-wide and is
  // what actually guards against it coming back anywhere.
  { id: 'F2.3', intent: 'the default accent is Venus purple, not Cloudflare orange',
    holds: () => matches('packages/workshop-frontend/src/theme.ts', /DEFAULT_ACCENT_COLOR = '#6c5ce7'/) },
  { id: 'F2.4', intent: 'the Contentstack mark is what the shell renders',
    holds: () => has('packages/workshop-frontend/src/components/ContentstackMark.tsx')
              && has('packages/workshop-frontend/public/contentstack-logo.svg') },
  { id: 'F2.5', intent: 'gatekeeper connect pages take their palette from design-tokens',
    holds: () => matches('packages/mcp-shared/src/html.ts', /packages\/design-tokens\/tokens\.css/) },
  { id: 'F2.6', intent: 'the legacy-palette ratchet still guards against Cloudflare colours',
    holds: () => has('scripts/legacy-palette.test.ts') },

  // ---- F3  Type scale and contrast remediation ------------------------------------------------
  { id: 'F3.1', intent: 'the text-ui-* scale is what sizes UI text',
    holds: () => fileCount('packages/workshop-frontend/src', /text-ui-/) >= 40 },
  { id: 'F3.2', intent: 'the sizing and contrast ratchets still run',
    holds: () => has('scripts/design-tokens.test.ts')
              && has('packages/workshop-frontend/src/designTokens.test.ts') },
  { id: 'F3.3', intent: 'Inter Variable is actually shipped, not just named',
    holds: () => has('packages/workshop-frontend/public/fonts/InterVariable.woff2') },
  { id: 'F3.4', intent: 'the accent variable list stays derived, so a test cannot drift from it',
    holds: () => matches('packages/workshop-shared/src/theme.ts', /export const ACCENT_VAR_NAMES/)
              && matches('packages/workshop-frontend/src/theme.ts', /ACCENT_VAR_NAMES/) },

  // ---- F4  Context Library CI ingestion ------------------------------------------------------
  { id: 'F4.1', intent: 'the ingestion pipeline modules exist',
    holds: () => ['ingest-handler', 'ingest-manifest', 'ingest-token', 'write-guard', 'document-path']
      .every(name => has(`packages/gatekeeper-context/src/${name}.ts`)) },
  { id: 'F4.2', intent: 'the worker serves ingestion over HTTP as a WorkerEntrypoint',
    holds: () => matches('packages/gatekeeper-context/src/index.ts', /handleIngestRequest/)
              && matches('packages/gatekeeper-context/src/index.ts', /WorkerEntrypoint/) },
  { id: 'F4.3', intent: 'ingestion is rate limited globally as well as per collection',
    holds: () => matches('packages/gatekeeper-context/src/index.ts', /INGEST_GLOBAL_LIMIT_KEY/) },
  { id: 'F4.4', intent: 'ingestion token types are on the gatekeeper API',
    holds: () => matches('packages/gatekeeper-context/src/context-types.ts', /ContextIngestTokenCreateResult/) },
  { id: 'F4.5', intent: 'ratelimit bindings survive into the release manifest',
    holds: () => matches('scripts/release/manifest-lib.ts', /ratelimits/) },

  // ---- F5  Explicit workspace creation -------------------------------------------------------
  { id: 'F5.1', intent: 'createWorkspace is on the RPC API and implemented',
    holds: () => matches('packages/workshop-shared/src/api.ts', /createWorkspace\(title\?: string\)/)
              && matches('packages/workshop-backend/src/server.ts', /async createWorkspace/) },
  { id: 'F5.2', intent: 'all creation paths share one register-and-open, with rollback',
    holds: () => matches('packages/workshop-backend/src/server.ts', /#registerAndOpen/)
              && matches('packages/workshop-backend/src/server.ts', /#cleanupFailedCreate/) },
  { id: 'F5.3', intent: 'a user-chosen title is latched against auto-naming',
    holds: () => matches('packages/workshop-backend/src/overseer.ts', /titleChosenByUser/)
              && has('packages/workshop-backend/src/workspace-title.ts') },
  { id: 'F5.4', intent: 'analytics can tell a named workspace from a speculative one',
    holds: () => matches('packages/workshop-backend/src/analytics.ts', /"blank" \| "named" \| "blueprint"/) },
  { id: 'F5.5', intent: 'the default workspace title is a shared constant',
    holds: () => matches('packages/workshop-shared/src/api.ts', /export const DEFAULT_WORKSPACE_TITLE/) },
  { id: 'F5.6', intent: 'the create-workspace dialog and its bus exist',
    holds: () => has('packages/workshop-frontend/src/components/CreateWorkspaceDialog.tsx')
              && has('packages/workshop-frontend/src/components/AppShell/createWorkspaceBus.ts') },

  // ---- F6  Chat timeline rail and composer ---------------------------------------------------
  { id: 'F6.1', intent: 'the timeline rail is derived by its own module, not inline',
    holds: () => has('packages/workshop-frontend/src/chatRail.ts')
              && matches('packages/workshop-frontend/src/ChatInterface.tsx', /chatRail|railToneFor|RailNode/) },
  { id: 'F6.2', intent: 'the composer surface is flat, with no top border',
    holds: () => matches('packages/workshop-frontend/src/ChatInterface.tsx', /shrink-0 bg-kumo-base/) },

  // ---- F7  Self-hosting deploy harness -------------------------------------------------------
  // Upstream ships no way to deploy a fork: `scripts/release/` targets Cloudflare's own hosted
  // deploy service, and the sanctioned alternative is a separate starter repository that pins
  // upstream as a submodule. This fork deploys its own checkout, so the harness lives here.
  { id: 'F7.1', intent: 'the deploy harness, its tracked template and both guides exist',
    holds: () => has('scripts/deploy/deploy.ts')
              && has('scripts/deploy/deployment-config.ts')
              && has('deployment.example.jsonc')
              && has('CLOUDFLARE_SETUP.md')
              && has('docs/self-hosting.md') },
  { id: 'F7.2', intent: 'the harness derives its topology from the committed wrangler configs',
    holds: () => matches('scripts/deploy/deployment-config.ts', /from "\.\.\/release\/manifest-lib\.ts"/) },
  { id: 'F7.3', intent: 'a deployment is reachable from the root scripts',
    holds: () => matches('package.json', /"deploy:check": *"node scripts\/deploy\/deploy\.ts --check"/) },
  { id: 'F7.4', intent: 'one deployment\'s own description and secrets stay untracked',
    holds: () => matches('.gitignore', /^deployment\.jsonc$/m)
              && matches('.gitignore', /^\.deploy\.vars$/m) },
  { id: 'F7.5', intent: 'local dev inherits the deployment\'s model catalog rather than restating it',
    holds: () => matches('scripts/deploy/deployment-config.ts', /export function modelCatalogVars/)
              && matches('scripts/run-dev-server.ts', /modelCatalogVars/) },

  // ---- F8  Deployment-scoped sign-in restriction --------------------------------------------
  // Upstream's sign-in is open to anyone the provider will vouch for, and its sessions never
  // expire. This deployment admits one email domain and re-checks with the provider on a schedule.
  { id: 'F8.1', intent: 'every email-keyed entry point enforces the domain allowlist',
    holds: () => matches('packages/workshop-backend/src/auth/login-flow.ts', /isEmailAllowed/)
              && matches('packages/workshop-backend/src/server.ts', /isEmailAllowed/) },
  // The `has` check is load-bearing: matches() reports false for a missing file, so a bare
  // negation would pass vacuously if admin-config.ts were ever renamed.
  { id: 'F8.2', intent: 'the allowlist is env-driven, never part of AdminConfig',
    holds: () => matches('packages/workshop-backend/src/auth/config.ts', /ALLOWED_EMAIL_DOMAINS/)
              && has('packages/workshop-backend/src/admin-config.ts')
              && !matches('packages/workshop-backend/src/admin-config.ts', /ALLOWED_EMAIL_DOMAINS/) },
  { id: 'F8.3', intent: 'a configured allowlist disables password auth, failing closed not open',
    holds: () => matches('packages/workshop-backend/src/auth/config.ts',
                         /getAllowedEmailDomains\(env\)\.length > 0\) return false/) },
  { id: 'F8.4', intent: 'session tokens expire against a configurable maximum age',
    holds: () => matches('packages/workshop-backend/src/user.ts', /getSessionMaxAgeMs/) },
  { id: 'F8.5', intent: 'the deploy harness rejects a config whose admins cannot sign in',
    holds: () => matches('scripts/deploy/deployment-config.ts', /would never be able to reach/) },
]

test('every fork intent has a unique, stable id', () => {
  const ids = INTENTS.map(entry => entry.id)
  assert.deepEqual(ids, [...new Set(ids)], 'duplicate intent id')
})

test('docs/fork-delta.md accounts for every asserted intent', () => {
  const ledger = read('docs/fork-delta.md')
  const undocumented = INTENTS.filter(entry => !ledger.includes(entry.id)).map(entry => entry.id)
  assert.deepEqual(undocumented, [],
    'these intents are asserted but absent from the ledger, so a reviewer cannot see what they ' +
    'protect. Add a row to docs/fork-delta.md.')
})

test('the fork still differs from upstream in every way it means to', () => {
  const lost = INTENTS.filter(entry => !entry.holds()).map(entry => `${entry.id}  ${entry.intent}`)
  assert.deepEqual(lost, [],
    'an upstream merge (or ordinary work) undid fork intent. If upstream had to displace it, cede ' +
    'it deliberately: move the row to the Ceded table in docs/fork-delta.md with the reason and ' +
    'upstream commit, and delete the assertion in the same commit. See ' +
    'docs/upstream-merge-runbook.md.')
})
