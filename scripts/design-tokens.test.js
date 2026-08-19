// Guards for the Contentstack text ramp. See
// docs/superpowers/specs/2026-08-19-type-and-contrast-remediation-design.md
//
// These tests exist because the 2026-08-06 re-skin measured #a9b6cb at 2.05:1, wrote down that it
// would become a defect if used for anything but disabled state, and deferred the audit. It was
// used for content 212 times. Computed guards, not prose, are what stop that happening again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKENS = join(ROOT, 'packages/design-tokens/tokens.css')
const KUMO_DIST = join(ROOT, 'packages/workshop-frontend/node_modules/@cloudflare/kumo/dist')

// The light palette is the first `@theme { ... }` block; the dark palette lives in a separate
// [data-mode="dark"] block and is deliberately out of scope (spec T9).
export function lightTheme() {
  const css = readFileSync(TOKENS, 'utf8')
  const open = css.indexOf('@theme {')
  const body = css.slice(open, css.indexOf('\n}', open))
  const map = new Map()
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    map.set(name, value.trim())
  }
  return map
}

function kumoFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) kumoFiles(full, out)
    else if (/\.(css|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

test('every Kumo text token that Kumo references is given a Contentstack value', () => {
  const referenced = new Set()
  for (const file of kumoFiles(KUMO_DIST)) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/--(text-color-kumo-[a-z-]+)/g)) {
      referenced.add(`--${name}`)
    }
  }
  const declared = lightTheme()
  const missing = [...referenced].filter((t) => !declared.has(t)).toSorted()
  assert.deepEqual(missing, [], 'declare these in packages/design-tokens/tokens.css')
})

const channel = (c) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Text that carries meaning. Every one of these must be readable on every surface it can land on.
const CONTENT_TOKENS = [
  '--text-color-kumo-strong',
  '--text-color-kumo-default',
  '--text-color-kumo-subtle',
  '--text-color-kumo-link',
  '--text-color-kumo-brand',
  '--text-color-kumo-danger',
  '--text-color-kumo-success',
  '--text-color-kumo-warning',
  '--text-color-kumo-info',
]

test('every content text token clears WCAG AA on every light surface', () => {
  const theme = lightTheme()
  const surfaces = [
    ['base', '#ffffff'],
    ['elevated', theme.get('--color-kumo-elevated')],
    ['tint', theme.get('--color-kumo-tint')],
  ]
  const failures = []
  for (const token of CONTENT_TOKENS) {
    const value = theme.get(token)
    assert.match(value, /^#[0-9a-f]{6}$/i, `${token} must be a 6-digit hex to be checked`)
    for (const [label, surface] of surfaces) {
      const ratio = contrast(value, surface)
      if (ratio < 4.5) failures.push(`${token} on ${label}: ${ratio.toFixed(2)}`)
    }
  }
  assert.deepEqual(failures, [], 'these fail AA as body text')
})

// The inverse guard. `inactive` marks a control the user cannot operate; if it becomes readable it
// stops communicating that, and content starts being written in it again — which is the exact
// regression this whole change is remediating.
test('inactive stays below AA, so it cannot be reused for content', () => {
  const value = lightTheme().get('--text-color-kumo-inactive')
  const ratio = contrast(value, '#ffffff')
  assert.ok(ratio < 4.5, `inactive is ${ratio.toFixed(2)}:1 — too readable to mean "disabled"`)
})

test('placeholder clears AA on the surfaces placeholders actually occupy', () => {
  const theme = lightTheme()
  for (const surface of ['#ffffff', theme.get('--color-kumo-elevated')]) {
    const ratio = contrast(theme.get('--text-color-kumo-placeholder'), surface)
    assert.ok(ratio >= 4.5, `placeholder on ${surface} is ${ratio.toFixed(2)}:1`)
  }
})
