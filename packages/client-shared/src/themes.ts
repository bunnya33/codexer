export type ThemeId = 'default' | 'paper' | 'warm-dark';

const defaultColors = {
  bg: '#ffffff', surface: '#ffffff', text: '#191d1e', muted: '#687275', line: '#e8e9e9', accent: '#147bb5', soft: '#eef4f7', danger: '#b33942', code: '#f4f5f5',
  sidebar: '#f8f9f9', input: '#f2f3f3', bubble: '#f1f2f2', composer: '#fafafa', composerBorder: '#e9ebec',
  faint: '#b2b8ba', ring: '#d2d7d9', subtleLine: '#eceeef', question: '#808581', questionBg: '#fafbfb', optionBorder: '#bbc2c5',
  success: '#159447', online: '#24a66b', offline: '#a8b3b3', warningBg: '#fff7eb', warningBorder: '#eed9b2',
  diffBg: '#f8f9fa', diffAddedBg: '#dafbe1', diffAddedText: '#116329', diffDeletedBg: '#ffebe9', diffDeletedText: '#a40e26', diffHunkBg: '#eef4f8', diffHunkText: '#576f80',
  heading: '#191d1e', headingSecondary: '#191d1e', syntaxKeyword: '#9b287d', syntaxString: '#217d56', syntaxNumber: '#a05b10', syntaxTitle: '#1174ac',
  solid: '#191d1e', onSolid: '#ffffff', onAccent: '#ffffff', mode: '#e4edf1', jumpBorder: '#e0e3e4', settingsGroup: '#f4f4f4', settingsLine: '#dcdedf',
  slider: '#2d88d4', sliderTrack: '#e9e9eb', sliderDot: '#c7c8ca', sliderSelectedDot: '#75b4e7', thumb: '#ffffff', thumbBorder: '#ecedef',
  glass: '#ffffff', glassBorder: '#eceeee', overlay: '#00000044', shadow: '#182127', shimmer: '#9aa1a3', shimmerHighlight: '#56676d',
};
export type ThemeColors = { readonly [K in keyof typeof defaultColors]: string };
export type ControlTheme = { id: ThemeId; name: string; description: string; dark: boolean; colors: ThemeColors };

export const controlThemes: readonly ControlTheme[] = [
  { id: 'default', name: '默认', description: '清爽白色 · 经典蓝', dark: false, colors: defaultColors },
  { id: 'paper', name: '暖白纸张', description: '暖白底色 · 深棕文字', dark: false, colors: {
    bg: '#faf7f1', surface: '#faf7f1', text: '#3d3730', muted: '#6f675d', line: '#ded8ce', accent: '#0e6e63', soft: '#e3ebe4', danger: '#ad4541', code: '#eeeae2',
    sidebar: '#f1ede5', input: '#eae6dd', bubble: '#ece7de', composer: '#f4f0e8', composerBorder: '#ded8cd',
    faint: '#938a7c', ring: '#d1c9bc', subtleLine: '#e2ddd3', question: '#6f675d', questionBg: '#f2eee6', optionBorder: '#b7ae9f',
    success: '#34734b', online: '#378365', offline: '#a0988c', warningBg: '#f2ead7', warningBorder: '#dac79f',
    diffBg: '#f5f1e9', diffAddedBg: '#e1eddc', diffAddedText: '#2e633c', diffDeletedBg: '#f4e1da', diffDeletedText: '#9c3934', diffHunkBg: '#e7e9e5', diffHunkText: '#526778',
    heading: '#2d4767', headingSecondary: '#6d4d8b', syntaxKeyword: '#80558d', syntaxString: '#3b7151', syntaxNumber: '#985522', syntaxTitle: '#0e6e63',
    solid: '#3d3730', onSolid: '#faf7f1', onAccent: '#ffffff', mode: '#dfe8df', jumpBorder: '#d4cdbf', settingsGroup: '#f0ece3', settingsLine: '#dad3c7',
    slider: '#0e6e63', sliderTrack: '#e4ded3', sliderDot: '#bfb5a5', sliderSelectedDot: '#80b7a8', thumb: '#faf7f1', thumbBorder: '#d7cfc0',
    glass: '#f3efe5e8', glassBorder: '#ded7c8', overlay: '#31291d44', shadow: '#3d3022', shimmer: '#91887b', shimmerHighlight: '#554e43',
  } },
  { id: 'warm-dark', name: '暖棕暗色', description: '暖棕底色 · 柔和冷色点缀', dark: true, colors: {
    bg: '#262322', surface: '#262322', text: '#cfc7bd', muted: '#a49a8e', line: '#443e39', accent: '#6db3a3', soft: '#303f3a', danger: '#ed9890', code: '#302c29',
    sidebar: '#211e1c', input: '#322e2b', bubble: '#38322d', composer: '#2e2926', composerBorder: '#4b423b',
    faint: '#a09689', ring: '#534a42', subtleLine: '#423a34', question: '#a99e91', questionBg: '#2d2926', optionBorder: '#71665a',
    success: '#94c49d', online: '#7db698', offline: '#84796d', warningBg: '#3c3326', warningBorder: '#6e583b',
    diffBg: '#292522', diffAddedBg: '#2c3c2f', diffAddedText: '#aed4ac', diffDeletedBg: '#4b2e2b', diffDeletedText: '#f0b1a6', diffHunkBg: '#30363c', diffHunkText: '#a7bfd4',
    heading: '#88aad6', headingSecondary: '#ba9cdb', syntaxKeyword: '#c4a0da', syntaxString: '#9ac09a', syntaxNumber: '#e5a66e', syntaxTitle: '#83bdc5',
    solid: '#6db3a3', onSolid: '#1c2925', onAccent: '#1c2925', mode: '#30443b', jumpBorder: '#5a4f45', settingsGroup: '#302b27', settingsLine: '#4b423a',
    slider: '#6db3a3', sliderTrack: '#494038', sliderDot: '#877666', sliderSelectedDot: '#b5d8c7', thumb: '#cfc7bd', thumbBorder: '#938575',
    glass: '#322c27eb', glassBorder: '#584c40', overlay: '#0f0c0a88', shadow: '#000000', shimmer: '#a69a8c', shimmerHighlight: '#e4d8c8',
  } },
];

export function themeId(value: unknown): ThemeId {
  return controlThemes.some(theme => theme.id === value) ? value as ThemeId : 'default';
}
export function controlTheme(value: unknown): ControlTheme {
  return controlThemes.find(theme => theme.id === value) ?? controlThemes[0]!;
}
