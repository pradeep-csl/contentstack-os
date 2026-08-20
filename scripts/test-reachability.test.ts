// Guards that every test file in the repo is actually reachable by a configured runner.
//
// This exists because of a specific way upstream merges hurt a fork: a test keeps existing, keeps
// passing when run by hand, and silently stops running in CI, because the thing that *selects* it
// changed. Two of those happened in the 2026-08-20 upstream merge:
//
//  - The root `test` script's glob moved from `scripts/*.test.js` to `scripts/**/*.test.ts`, so the
//    fork's two design ratchets stopped being executed at all.
//  - `gatekeeper-context`'s workers suite is selected by the Vite+ `test` task in `vite.config.ts`,
//    not by the package.json script, so adding the second command to the script alone left
//    `vitest.workers.config.ts` orphaned.
//
// Neither failed anything. That is the whole problem: a test that is not run is indistinguishable
// from a test that passes. These checks derive their own coverage from what is on disk, so unlike a
// hand-written list they cannot silently fail to cover a newly added file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-app', '.wrangler', '.git', 'generated', 'build', 'testdata',
])

/** Every file under `dir` whose name marks it as a test, as repo-relative paths. */
function testFilesUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) testFilesUnder(full, out)
    else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) out.push(repoPath(full))
  }
  return out
}

const repoPath = (file: string) => relative(ROOT, file).split(sep).join('/')

/** Workspace package directories, as repo-relative paths. */
function packageDirs(): string[] {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(ROOT, 'packages', entry.name, 'package.json')))
    .map(entry => `packages/${entry.name}`)
    .toSorted()
}

const read = (repoRelative: string) => readFileSync(join(ROOT, repoRelative), 'utf8')

/**
 * The narrow slice of glob syntax the root `test` script uses, as a regex anchored to a whole
 * repo-relative path. `**` crosses directory separators, `*` does not, and a brace list is an
 * alternation -- enough for `scripts/**\/*.test.ts` and for whatever it is widened to next.
 */
function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero directories, so the separator is part of the optional group.
        if (glob[i + 2] === '/') { source += '(?:.*/)?'; i += 2 } else { source += '.*'; i += 1 }
      } else {
        source += '[^/]*'
      }
    } else if (char === '{') {
      const close = glob.indexOf('}', i)
      assert.notEqual(close, -1, `unterminated brace list in glob: ${glob}`)
      const alternatives = glob.slice(i + 1, close).split(',').map(a => a.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      source += `(?:${alternatives.join('|')})`
      i = close
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

test('globToRegExp handles the shapes the root test script uses', () => {
  const glob = globToRegExp('scripts/**/*.test.ts')
  assert.equal(glob.test('scripts/design-tokens.test.ts'), true)
  assert.equal(glob.test('scripts/release/manifest-lib.test.ts'), true)
  assert.equal(glob.test('scripts/design-tokens.test.js'), false)
  assert.equal(glob.test('packages/router/src/a.test.ts'), false)
  const braced = globToRegExp('scripts/**/*.test.{ts,js}')
  assert.equal(braced.test('scripts/legacy-palette.test.js'), true)
  assert.equal(braced.test('scripts/legacy-palette.test.ts'), true)
})

// `node --test` is given explicit globs, so a test file whose name the globs do not match is simply
// never loaded. This is exactly what silently benched the fork's two design ratchets when the glob
// gained a `.ts` extension they did not have.
test('every test file under scripts/ is matched by the root test script globs', () => {
  const script: string = JSON.parse(read('package.json')).scripts.test
  const globs = [...script.matchAll(/node --test\s+((?:'[^']+'|"[^"]+"|[^\s&|]+)(?:\s+(?:'[^']+'|"[^"]+"))*)/g)]
    .flatMap(match => match[1].match(/'[^']+'|"[^"]+"|[^\s]+/g) ?? [])
    .map(raw => raw.replace(/^['"]|['"]$/g, ''))
  assert.ok(globs.length > 0, `no "node --test" globs found in the root test script: ${script}`)

  const patterns = globs.map(globToRegExp)
  const unreached = testFilesUnder(join(ROOT, 'scripts'))
    .filter(file => !patterns.some(pattern => pattern.test(file)))
    .toSorted()
  assert.deepEqual(unreached, [],
    `these test files exist but no root "node --test" glob (${globs.join(', ')}) selects them, so ` +
    'they never run. Rename them to match, or widen the glob in the root package.json.')
})

// A bare `vitest run` picks up `vitest.config.ts` implicitly, so only the extra configs need naming.
const IMPLICIT_VITEST_CONFIG = 'vitest.config.ts'

/**
 * A second vitest config is inert unless something invokes it by name. Vite+ runs the `test` task
 * declared in `vite.config.ts`, and vp forbids a task and a script sharing a name, so the task -- not
 * the package.json script -- is what `pnpm test` and CI actually execute. A config named only in the
 * script therefore never runs, which is how the Context Library's workerd suite was orphaned.
 */
test('no vitest config is orphaned: every extra config is invoked by name', () => {
  const orphans: string[] = []
  for (const pkg of packageDirs()) {
    const extras = readdirSync(join(ROOT, pkg))
      .filter(name => /^vitest\..*config\.[cm]?[jt]s$/.test(name) && name !== IMPLICIT_VITEST_CONFIG)
    if (extras.length === 0) continue

    // Deliberately NOT package.json: a config named only in `test:run` is the false-safety case
    // this guard exists for. vp runs the task, so the task is the only mention that means the
    // suite executes. The fallback is for a package with no Vite+ config at all, where a
    // package.json script is the only thing there is to run.
    const viteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mts']
      .map(name => join(pkg, name))
      .find(candidate => existsSync(join(ROOT, candidate)))
    const haystack = read(viteConfig ?? join(pkg, 'package.json'))
    for (const extra of extras) {
      if (!haystack.includes(extra)) orphans.push(`${pkg}/${extra}`)
    }
  }
  assert.deepEqual(orphans.toSorted(), [],
    'these vitest configs are not named by their package\'s Vite+ `test` task, so the suites they ' +
    'select never run under `pnpm test` -- naming them in a package.json script is not enough, ' +
    'because vp runs the task. Add the command to the `test` task (see gatekeeper-scheduler for ' +
    'the two-suite shape).')
})

// The task, not the script, is what `pnpm test` runs -- so a package can own tests, own a vitest
// config, pass when run by hand, and still contribute nothing to CI.
test('every package that owns test files declares a way to run them', () => {
  const unrunnable: string[] = []
  for (const pkg of packageDirs()) {
    if (testFilesUnder(join(ROOT, pkg)).length === 0) continue

    const viteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mts']
      .map(name => join(pkg, name))
      .find(candidate => existsSync(join(ROOT, candidate)))
    const declaresTask = viteConfig !== undefined && /\btest\s*:/.test(read(viteConfig))
    const scripts = JSON.parse(read(join(pkg, 'package.json'))).scripts ?? {}
    const declaresScript = 'test' in scripts || 'test:run' in scripts
    if (!declaresTask && !declaresScript) unrunnable.push(pkg)
  }
  assert.deepEqual(unrunnable.toSorted(), [],
    'these packages contain test files but declare neither a Vite+ `test` task nor a test script, ' +
    'so their tests never run.')
})

// The fork's own suites are the ones an upstream merge can quietly bench, since upstream has no
// reason to keep them selected. Named explicitly so a rename or a move has to be deliberate.
const FORK_SUITE_HOMES = [
  'scripts/design-tokens.test.ts',
  'scripts/legacy-palette.test.ts',
  'packages/gatekeeper-context/vitest.workers.config.ts',
]

test('the fork\'s own guard suites are still where the runners look for them', () => {
  const missing = FORK_SUITE_HOMES.filter(path => !existsSync(join(ROOT, path))).toSorted()
  assert.deepEqual(missing, [],
    'a fork-owned guard suite moved or was deleted. If that was deliberate, update ' +
    'FORK_SUITE_HOMES and docs/fork-delta.md in the same commit; see the cede protocol in ' +
    'docs/upstream-merge-runbook.md.')
})
