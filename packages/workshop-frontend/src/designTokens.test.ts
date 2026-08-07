import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL('../../design-tokens/tokens.css', import.meta.url)),
  'utf8',
)

/** Extracts the body of the `@theme { … }` block (light mode). */
export function lightBlock(css: string): string {
  const start = css.indexOf('@theme {')
  if (start === -1) throw new Error('no @theme block')
  return css.slice(start, css.indexOf('\n}', start))
}

/** Extracts the body of the `[data-mode="dark"] { … }` block. */
export function darkBlock(css: string): string {
  const start = css.indexOf('[data-mode="dark"] {')
  if (start === -1) throw new Error('no dark block')
  return css.slice(start, css.indexOf('\n}', start))
}

/** Reads a custom property's value out of a block body. */
export function token(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
  if (!match) throw new Error(`token ${name} not found`)
  return match[1].trim()
}

// Every Kumo semantic token the app relies on. A token silently dropped during the extraction
// would fall back to Kumo's own default and quietly de-theme part of the UI.
const REQUIRED_TOKENS = [
  '--color-kumo-base', '--color-kumo-elevated', '--color-kumo-tint',
  '--color-kumo-overlay', '--color-kumo-recessed', '--color-kumo-control',
  '--color-kumo-contrast', '--color-kumo-fill', '--color-kumo-fill-hover',
  '--color-kumo-interact', '--color-kumo-brand', '--color-kumo-brand-hover',
  '--color-kumo-line', '--color-kumo-ring', '--color-kumo-bubble-user',
  '--color-kumo-info', '--color-kumo-info-tint',
  '--color-kumo-warning', '--color-kumo-warning-tint',
  '--color-kumo-danger', '--color-kumo-danger-tint',
  '--color-kumo-success', '--color-kumo-success-tint',
  '--text-color-kumo-default', '--text-color-kumo-default-hover',
  '--text-color-kumo-inverse', '--text-color-kumo-strong',
  '--text-color-kumo-subtle', '--text-color-kumo-inactive',
  '--text-color-kumo-brand', '--text-color-kumo-link',
  '--text-color-kumo-success', '--text-color-kumo-danger', '--text-color-kumo-warning',
]

describe('shared design tokens', () => {
  it('defines every required token in light mode', () => {
    const block = lightBlock(TOKENS_CSS)
    const missing = REQUIRED_TOKENS.filter((t) => !block.includes(`${t}:`))
    expect(missing).toEqual([])
  })

  it('defines every required token in dark mode', () => {
    const block = darkBlock(TOKENS_CSS)
    const missing = REQUIRED_TOKENS.filter((t) => !block.includes(`${t}:`))
    expect(missing).toEqual([])
  })

  it('does not redefine the type scale or spacing base', () => {
    // These are deliberately out of scope; a stray definition here would reflow the whole app.
    for (const forbidden of ['--text-xs:', '--text-sm:', '--text-base:', '--text-lg:', '--spacing:']) {
      expect(TOKENS_CSS).not.toContain(forbidden)
    }
  })
})
