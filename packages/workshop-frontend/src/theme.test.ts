// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { ACCENT_VAR_NAMES, applyAccentColor, DEFAULT_ACCENT_COLOR } from './theme'

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('runtime accent seeding', () => {
  it('defaults to the Venus brand purple', () => {
    expect(DEFAULT_ACCENT_COLOR).toBe('#6c5ce7')
  })

  it('pins the dark brand fill to L=0.45 to ensure white button text stays legible for any seed', () => {
    applyAccentColor('#ffd400')
    const brand = document.documentElement.style.getPropertyValue('--color-kumo-brand')
    // The dark arm of light-dark() must pin to 0.45, which is the threshold that guarantees
    // WCAG AA contrast (4.95:1 worst case, at hue ~185) for white label text on any seed.
    expect(brand).toContain('0.45 c h')
    expect(brand).not.toContain('clamp(')
  })

  it('keeps the brand and accent-100 dark derivations in sync to prevent silent drift', () => {
    applyAccentColor('#ffd400')
    const brand = document.documentElement.style.getPropertyValue('--color-kumo-brand')
    const accent100 = document.documentElement.style.getPropertyValue('--color-accent-100')
    // Both should contain the same dark-arm derivation so they cannot drift apart.
    // Brand uses the light arm as-is and pins the dark arm to 0.45.
    expect(brand).toContain('0.45 c h')
    // Accent-100 uses the same formula.
    expect(accent100).toContain('0.45 c h')
  })

  it('clears every accent variable when given an invalid colour', () => {
    applyAccentColor(DEFAULT_ACCENT_COLOR)
    applyAccentColor('not-a-colour')
    for (const name of ACCENT_VAR_NAMES) {
      expect(document.documentElement.style.getPropertyValue(name), `${name}`).toBe('')
    }
  })
})
