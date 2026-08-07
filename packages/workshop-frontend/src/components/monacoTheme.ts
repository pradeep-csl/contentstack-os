/**
 * Shared Monaco theme + monospace font stack used by both CodeEditor (full
 * editing surface) and CodeDiffEditor (read-mostly unified-diff renderer).
 *
 * Monaco renders into its own DOM that doesn't reliably inherit the page's
 * `--font-mono` CSS variable, so editor instances pass `monoFont` as an
 * explicit option. The CSS in CodeDiffEditor's view zones is in the same
 * boat — Monaco view zone DOM nodes don't pick up our body font either.
 *
 * The theme itself is shared because the diff editor and the regular editor
 * should look identical when displaying the same file; the diff editor only
 * adds line-level decorations on top.
 */

import type { ResolvedThemeMode } from '../theme'

export const GADGETS_CODE_THEME_LIGHT = 'gadgets-code-light'
export const GADGETS_CODE_THEME_DARK = 'gadgets-code-dark'

export const monoFont =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

let themesDefined = false

export function getGadgetsCodeTheme(theme: ResolvedThemeMode): string {
  return theme === 'dark' ? GADGETS_CODE_THEME_DARK : GADGETS_CODE_THEME_LIGHT
}

export function defineGadgetsCodeTheme(monaco: typeof import('monaco-editor')): void {
  if (themesDefined) return

  monaco.editor.defineTheme(GADGETS_CODE_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '222222' },
      { token: 'comment', foreground: '8593ab', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6c5ce7' },
      { token: 'storage', foreground: '6c5ce7' },
      { token: 'operator', foreground: '647696' },
      { token: 'string', foreground: '007a52' },
      { token: 'number', foreground: 'ba5800' },
      { token: 'type', foreground: 'ba5800' },
      { token: 'class', foreground: 'ba5800' },
      { token: 'interface', foreground: 'ba5800' },
      { token: 'function', foreground: '0469e3' },
      { token: 'variable', foreground: '222222' },
      { token: 'variable.predefined', foreground: '0469e3' },
      { token: 'constant', foreground: 'ba5800' },
      { token: 'delimiter', foreground: '647696' },
      { token: 'tag', foreground: 'd62400' },
      { token: 'attribute.name', foreground: 'ba5800' },
      { token: 'attribute.value', foreground: '007a52' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#222222',
      'editorLineNumber.foreground': '#a9b6cb',
      'editorLineNumber.activeForeground': '#647696',
      'editorCursor.foreground': '#222222',
      'editor.selectionBackground': '#dcd7fa',
      'editor.inactiveSelectionBackground': '#edf1f7',
      'editor.selectionHighlightBackground': '#e8e4fb',
      'editor.wordHighlightBackground': '#e8e4fb',
      'editor.wordHighlightStrongBackground': '#dcd7fa',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': '#ffffff',
      'editorIndentGuide.background1': '#edf1f7',
      'editorIndentGuide.activeBackground1': '#c7d0e1',
      'editorWhitespace.foreground': '#dde3ee',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#c7d0e133',
      'scrollbarSlider.hoverBackground': '#a9b6cb55',
      'scrollbarSlider.activeBackground': '#64769677',
    },
  })

  monaco.editor.defineTheme(GADGETS_CODE_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e6e4f0' },
      { token: 'comment', foreground: '7c7a94', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ada4f4' },
      { token: 'storage', foreground: 'ada4f4' },
      { token: 'operator', foreground: '9a97b0' },
      { token: 'string', foreground: '48dba2' },
      { token: 'number', foreground: 'ffbc36' },
      { token: 'type', foreground: 'ffbc36' },
      { token: 'class', foreground: 'ffbc36' },
      { token: 'interface', foreground: 'ffbc36' },
      { token: 'function', foreground: '74b4ff' },
      { token: 'variable', foreground: 'e6e4f0' },
      { token: 'variable.predefined', foreground: '74b4ff' },
      { token: 'constant', foreground: 'ffbc36' },
      { token: 'delimiter', foreground: '9a97b0' },
      { token: 'tag', foreground: 'ff735f' },
      { token: 'attribute.name', foreground: 'ffbc36' },
      { token: 'attribute.value', foreground: '48dba2' },
    ],
    colors: {
      'editor.background': '#13131b',
      'editor.foreground': '#e6e4f0',
      'editorLineNumber.foreground': '#6d6880',
      'editorLineNumber.activeForeground': '#9a97b0',
      'editorCursor.foreground': '#e6e4f0',
      'editor.selectionBackground': '#3b3468',
      'editor.inactiveSelectionBackground': '#2a2740',
      'editor.selectionHighlightBackground': '#2a2740',
      'editor.wordHighlightBackground': '#2a2740',
      'editor.wordHighlightStrongBackground': '#3b3468',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': '#13131b',
      'editorIndentGuide.background1': '#20202d',
      'editorIndentGuide.activeBackground1': '#383353',
      'editorWhitespace.foreground': '#2a2740',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#4b465f66',
      'scrollbarSlider.hoverBackground': '#5d587399',
      'scrollbarSlider.activeBackground': '#746d8fcc',
    },
  })

  themesDefined = true
}
