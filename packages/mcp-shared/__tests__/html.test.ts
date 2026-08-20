import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_STYLE } from "../src/html.js";

// `PAGE_STYLE` hand-copies a handful of Contentstack Venus tokens because the MCP connect/link-
// expired pages render outside the Workshop bundle entirely — no Tailwind, no Kumo, no @theme. That
// copy already drifted once: an earlier task retuned the whole ramp for AA contrast and updated
// every in-bundle consumer, but this hand-copy has no build-time link to tokens.css, so it kept
// shipping the pre-retune values (including the exact grey removed for failing AA) with every other
// guard green. This test re-derives the light palette from tokens.css on every run so that can't
// happen silently again.

const TOKENS_CSS = readFileSync(
  join(import.meta.dirname, "../../design-tokens/tokens.css"),
  "utf8",
);

function lightThemeBlock(css: string): string {
  const start = css.indexOf("@theme {");
  if (start === -1) throw new Error("no @theme block");
  return css.slice(start, css.indexOf("\n}", start));
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`token ${name} not found in tokens.css`);
  return match[1].trim();
}

// Mirrors PAGE_STYLE's own `--line` comment: tokens.css's light `--color-kumo-line` is a
// translucent `#rrggbbaa`; these standalone pages have no `color-mix()` build step to lean on, so
// PAGE_STYLE pre-composites it as a solid over white. Reproduced here (not imported) so the test
// fails if either side's arithmetic silently changes.
function compositeOverWhite(rgba: string): string {
  const hex = rgba.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = parseInt(hex.slice(6, 8), 16) / 255;
  const toHex = (c: number) => Math.round(255 * (1 - a) + c * a).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function cssVar(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`--${name} not found in PAGE_STYLE`);
  return match[1].trim();
}

describe("PAGE_STYLE tracks packages/design-tokens/tokens.css", () => {
  const light = lightThemeBlock(TOKENS_CSS);

  it("matches the light-mode content and line tokens", () => {
    expect(cssVar(PAGE_STYLE, "text")).toBe(token(light, "--text-color-kumo-default"));
    expect(cssVar(PAGE_STYLE, "strong")).toBe(token(light, "--text-color-kumo-strong"));
    expect(cssVar(PAGE_STYLE, "subtle")).toBe(token(light, "--text-color-kumo-subtle"));
    expect(cssVar(PAGE_STYLE, "brand")).toBe(token(light, "--text-color-kumo-brand"));
    expect(cssVar(PAGE_STYLE, "danger")).toBe(token(light, "--text-color-kumo-danger"));
    // The primary button's on-light colour intentionally tracks `strong`, not
    // `--color-kumo-contrast` (#222222) — that token predates the retune and was never AA-checked
    // on its own; `strong` already is.
    expect(cssVar(PAGE_STYLE, "contrast")).toBe(token(light, "--text-color-kumo-strong"));
    expect(cssVar(PAGE_STYLE, "line")).toBe(compositeOverWhite(token(light, "--color-kumo-line")));
  });
});
