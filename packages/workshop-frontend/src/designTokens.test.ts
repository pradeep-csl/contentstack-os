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

/** Converts `#rgb`, `#rrggbb` or `#rrggbbaa` to linear-light sRGB (alpha ignored). */
function hexToLinear(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  return channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two hex colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(hexToLinear(a)), relativeLuminance(hexToLinear(b))]
    .toSorted((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('Venus light palette', () => {
  const light = lightBlock(TOKENS_CSS)

  it('uses the Venus brand purple', () => {
    expect(token(light, '--color-kumo-brand')).toBe('#6c5ce7')
    expect(token(light, '--color-kumo-brand-hover')).toBe('#5d50be')
  })

  it('uses Venus cool-grey surfaces', () => {
    expect(token(light, '--color-kumo-base')).toBe('#ffffff')
    expect(token(light, '--color-kumo-elevated')).toBe('#f7f9fc')
    expect(token(light, '--color-kumo-tint')).toBe('#edf1f7')
    expect(token(light, '--color-kumo-recessed')).toBe('#dde3ee')
  })

  it('keeps the line token translucent so borders survive on every surface', () => {
    // A solid #dde3ee line is invisible on the recessed and fill-hover surfaces, which are
    // themselves #dde3ee. The token must carry alpha.
    const line = token(light, '--color-kumo-line')
    expect(line).toMatch(/^#[0-9a-f]{8}$/)
  })

  it('meets WCAG AA for body text on both light surfaces', () => {
    const base = token(light, '--color-kumo-base')
    const elevated = token(light, '--color-kumo-elevated')
    const body = token(light, '--text-color-kumo-default')
    expect(contrast(body, base)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(body, elevated)).toBeGreaterThanOrEqual(4.5)
  })

  it('meets WCAG AA for brand, link and status text on the base surface', () => {
    const base = token(light, '--color-kumo-base')
    for (const name of [
      '--text-color-kumo-brand', '--text-color-kumo-link', '--text-color-kumo-subtle',
      '--text-color-kumo-success', '--text-color-kumo-danger', '--text-color-kumo-warning',
    ]) {
      expect(contrast(token(light, name), base)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('meets WCAG AA for white label text on the primary button', () => {
    expect(contrast('#ffffff', token(light, '--color-kumo-brand'))).toBeGreaterThanOrEqual(4.5)
  })
})
