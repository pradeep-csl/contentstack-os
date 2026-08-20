import { describe, expect, it } from 'vitest'
// Vitest runs under node, but the src/ tsconfig only has browser types -- hence the suppressions,
// matching src/rpcErrors.test.ts.
// @ts-expect-error node builtin without @types/node
import { readFileSync } from 'node:fs'
// @ts-expect-error node builtin without @types/node
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
  '--text-color-kumo-placeholder', '--text-color-kumo-info',
  '--text-color-kumo-badge-orange-subtle', '--text-color-kumo-badge-teal-subtle',
  '--text-color-kumo-badge-neutral-subtle', '--text-color-kumo-badge-inverted',
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
    expect(token(light, '--color-kumo-elevated')).toBe('#f4f7fb')
    expect(token(light, '--color-kumo-tint')).toBe('#e9eef6')
    expect(token(light, '--color-kumo-recessed')).toBe('#dde3ee')
  })

  it('keeps the line token translucent so borders survive on every surface', () => {
    // A solid #dde3ee line is invisible on the recessed and fill-hover surfaces, which are
    // themselves #dde3ee. The token must carry alpha.
    const line = token(light, '--color-kumo-line')
    expect(line).toMatch(/^#[0-9a-f]{8}$/)
  })

  it('meets WCAG AA for white label text on the primary button', () => {
    expect(contrast('#ffffff', token(light, '--color-kumo-brand'))).toBeGreaterThanOrEqual(4.5)
  })

  // Text that carries meaning. Every one of these must be readable on every surface it can land
  // on. Supersedes (and subsumes) the narrower "body text on both light surfaces" and "brand,
  // link and status text on the base surface" checks: every token and surface those covered is
  // covered here too, plus --text-color-kumo-strong/--text-color-kumo-info and the tint surface.
  // Moved from scripts/design-tokens.test.ts (ruling R23) so there is one WCAG implementation,
  // not two that can quietly disagree.
  it('every content text token clears WCAG AA on every light surface', () => {
    const base = token(light, '--color-kumo-base')
    const surfaces = [base, token(light, '--color-kumo-elevated'), token(light, '--color-kumo-tint')]
    for (const name of [
      '--text-color-kumo-strong', '--text-color-kumo-default', '--text-color-kumo-subtle',
      '--text-color-kumo-link', '--text-color-kumo-brand', '--text-color-kumo-danger',
      '--text-color-kumo-success', '--text-color-kumo-warning', '--text-color-kumo-info',
    ]) {
      const value = token(light, name)
      for (const surface of surfaces) {
        expect(contrast(value, surface), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  // The inverse guard. `inactive` marks a control the user cannot operate; if it becomes
  // readable it stops communicating that, and content starts being written in it again — which
  // is the exact regression this whole change is remediating. Moved from
  // scripts/design-tokens.test.ts (ruling R23).
  it('keeps inactive below AA, so it cannot be reused for content', () => {
    const base = token(light, '--color-kumo-base')
    const ratio = contrast(token(light, '--text-color-kumo-inactive'), base)
    expect(ratio).toBeLessThan(4.5)
  })

  // Placeholders are measured to sit only on `base` or a transparent parent, never on `tint`.
  // Moved from scripts/design-tokens.test.ts (ruling R23).
  it('meets WCAG AA for placeholder text on the surfaces placeholders actually occupy', () => {
    const placeholder = token(light, '--text-color-kumo-placeholder')
    for (const surface of [token(light, '--color-kumo-base'), token(light, '--color-kumo-elevated')]) {
      expect(contrast(placeholder, surface), `placeholder on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  // Focus rings are a non-text UI indicator (WCAG 2.4.11/1.4.11), so the bar is 3:1, not the 4.5:1
  // body-text bar above. A prior fix pointed this token at --color-kumo-ring (1.55:1 on white) for
  // consistency with the app's own focus rings — levelling a conformant indicator down to a
  // non-conformant one. This guard is what should have caught that.
  it('meets WCAG non-text contrast (3:1) for the focus ring on every light surface', () => {
    const focus = token(light, '--color-kumo-focus')
    const surfaces = [
      token(light, '--color-kumo-base'), token(light, '--color-kumo-elevated'), token(light, '--color-kumo-tint'),
    ]
    for (const surface of surfaces) {
      expect(contrast(focus, surface), `focus on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })
})

/** Converts an `oklch(L C H)` string to linear-light sRGB, clipped to gamut. */
function oklchToLinear(value: string): [number, number, number] {
  const m = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (!m) throw new Error(`not an oklch colour: ${value}`)
  const [L, C, H] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]
}

const toSrgbChannel = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

/** Renders any oklch()/hex token value as a hex string so `contrast()` can consume it. */
function asHex(value: string): string {
  if (value.startsWith('#')) return value
  const rgb = oklchToLinear(value)
  return '#' + rgb.map((v) => Math.round(toSrgbChannel(v) * 255).toString(16).padStart(2, '0')).join('')
}

describe('Venus-derived dark palette', () => {
  const dark = darkBlock(TOKENS_CSS)

  it('keeps solid brand fills but lightens brand text (decision D5)', () => {
    expect(token(dark, '--color-kumo-brand')).toBe('#6c5ce7')
    expect(token(dark, '--text-color-kumo-brand')).toBe('#ada4f4')
    expect(token(dark, '--text-color-kumo-link')).toBe('#ada4f4')
  })

  it('uses the approved dark status colours (decision D6)', () => {
    expect(token(dark, '--color-kumo-success')).toBe('#48dba2')
    expect(token(dark, '--color-kumo-danger')).toBe('#ff735f')
    expect(token(dark, '--color-kumo-warning')).toBe('#ffbc36')
    expect(token(dark, '--color-kumo-info')).toBe('#74b4ff')
  })

  it('meets WCAG AA for text and status colours on all three dark surfaces', () => {
    const surfaces = ['--color-kumo-base', '--color-kumo-elevated', '--color-kumo-tint']
      .map((name) => asHex(token(dark, name)))
    const foregrounds = [
      '--text-color-kumo-default', '--text-color-kumo-subtle', '--text-color-kumo-brand',
      '--text-color-kumo-success', '--text-color-kumo-danger', '--text-color-kumo-warning',
    ]
    for (const name of foregrounds) {
      const fg = asHex(token(dark, name))
      for (const bg of surfaces) {
        expect(contrast(fg, bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('meets WCAG AA for white label text on the dark primary button', () => {
    expect(contrast('#ffffff', asHex(token(dark, '--color-kumo-brand')))).toBeGreaterThanOrEqual(4.5)
  })

  // Same non-text 3:1 bar as the light-mode focus check above. --color-kumo-focus was newly added
  // by this remediation tracking --color-kumo-ring's oklch(0.52 0.08 288), which only reached
  // 2.85:1 against --color-kumo-tint — this guard is what should have caught that.
  it('meets WCAG non-text contrast (3:1) for the focus ring on every dark surface', () => {
    const focus = asHex(token(dark, '--color-kumo-focus'))
    const surfaces = ['--color-kumo-base', '--color-kumo-elevated', '--color-kumo-tint']
      .map((name) => asHex(token(dark, name)))
    for (const surface of surfaces) {
      expect(contrast(focus, surface), `focus on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('Venus radius and elevation', () => {
  const light = lightBlock(TOKENS_CSS)
  const dark = darkBlock(TOKENS_CSS)

  it('uses the Venus radius ramp 2/4/6/8/10px', () => {
    expect(token(light, '--radius-sm')).toBe('0.125rem')
    expect(token(light, '--radius-md')).toBe('0.25rem')
    expect(token(light, '--radius-lg')).toBe('0.375rem')
    expect(token(light, '--radius-xl')).toBe('0.5rem')
    expect(token(light, '--radius-2xl')).toBe('0.625rem')
  })

  it('defines the elevation ramp in both modes', () => {
    for (const step of ['1', '4', '8', '16', '24']) {
      expect(light).toContain(`--shadow-venus-${step}:`)
      expect(dark).toContain(`--shadow-venus-${step}:`)
    }
  })

  it('tints light elevation with Venus purple and dark elevation with black', () => {
    expect(token(light, '--shadow-venus-4')).toContain('108, 92, 231')
    expect(token(dark, '--shadow-venus-4')).not.toContain('108, 92, 231')
  })

  it('drives every themed shadow utility from the ramp, not hardcoded warm browns', () => {
    // rgba(82, 16, 0, …) and rgba(20, 17, 16, …) were the Cloudflare-era shadow tints.
    expect(TOKENS_CSS).not.toContain('rgba(82, 16, 0')
    expect(TOKENS_CSS).not.toContain('rgba(20, 17, 16')
  })
})
