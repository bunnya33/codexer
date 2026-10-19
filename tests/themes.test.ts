import { expect, it } from 'vitest';
import { controlTheme, controlThemes, themeId } from '../packages/client-shared/src/themes';
import { codeRuns } from '../packages/client-shared/src/code-highlighting';

function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

it.each(controlThemes)('$name keeps reading, controls and diff foregrounds readable', theme => {
  const c = theme.colors;
  for (const [fg, bg] of [[c.text, c.bg], [c.text, c.bubble], [c.muted, c.bg], [c.onAccent, c.accent], [c.onSolid, c.solid], [c.diffAddedText, c.diffAddedBg], [c.diffDeletedText, c.diffDeletedBg], [c.diffHunkText, c.diffHunkBg], [c.syntaxKeyword, c.code], [c.syntaxString, c.code], [c.syntaxNumber, c.code], [c.syntaxTitle, c.code]]) {
    expect(contrast(fg!, bg!), `${theme.id}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  }
});

it('defaults corrupt or future preferences to the existing skin', () => {
  expect(controlThemes.map(theme => theme.id)).toEqual(['default', 'paper', 'warm-dark']);
  for (const value of [undefined, null, {}, 'unknown', '<script>']) {
    expect(themeId(value)).toBe('default'); expect(controlTheme(value).id).toBe('default');
  }
});

it.each(['typescript', 'xml', 'json', 'text'])('preserves literal code and entities in native highlighting (%s)', language => {
  const source = 'const html = "<script>&amp; &lt; &#39;</script>";\n// 中文 < > & "\'\n';
  expect(codeRuns(source, language).map(run => run.text).join('')).toBe(source);
});
