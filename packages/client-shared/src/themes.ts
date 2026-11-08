export type ThemeId = 'default' | 'paper' | 'warm-dark';

const defaultColors = {
  bg: '#ffffff', surface: '#ffffff', text: '#202124', muted: '#74767d', line: '#ebebef', accent: '#3565f6', soft: '#edf1fc', danger: '#b33942', code: '#f4f5f5',
  sidebar: '#f8f8fa', input: '#f3f3f6', bubble: '#edf2ff', composer: '#f3f3f6', composerBorder: '#f3f3f6',
  faint: '#a9aab0', timestamp: '#a3a3a3', ring: '#d2d7d9', subtleLine: '#eceeef', question: '#808581', questionBg: '#fafbfb', optionBorder: '#bbc2c5',
  success: '#159447', taskRunning: '#e39529', online: '#24a66b', offline: '#a8b3b3', warningBg: '#fff7eb', warningBorder: '#eed9b2',
  taskProjectBg: '#fff2df', taskThreadBg: '#fff8ee',
  diffBg: '#f8f9fa', diffAddedBg: '#dafbe1', diffAddedText: '#116329', diffDeletedBg: '#ffebe9', diffDeletedText: '#a40e26', diffHunkBg: '#eef4f8', diffHunkText: '#576f80',
  heading: '#191d1e', headingSecondary: '#191d1e', syntaxKeyword: '#9b287d', syntaxString: '#217d56', syntaxNumber: '#a05b10', syntaxTitle: '#1174ac',
  solid: '#3565f6', onSolid: '#ffffff', onAccent: '#ffffff', mode: '#e4edf1', jumpBorder: '#e0e3e4', settingsGroup: '#f4f4f4', settingsLine: '#dcdedf',
  slider: '#3565f6', sliderTrack: '#f6f6f8', sliderDot: '#d0d0d7', sliderSelectedDot: '#91adff', thumb: '#ffffff', thumbBorder: '#3867ed',
  glass: '#fcfcfe', glassBorder: '#eeeef2', overlay: '#00000044', shadow: '#182127', shimmer: '#9a9ba3', shimmerHighlight: '#535762',
};
export type ThemeColors = { readonly [K in keyof typeof defaultColors]: string };
export type ControlTheme = { id: ThemeId; name: string; description: string; dark: boolean; colors: ThemeColors };

export const controlThemes: readonly ControlTheme[] = [
  { id: 'default', name: '默认', description: '清爽白色 · 经典蓝', dark: false, colors: defaultColors },
  { id: 'paper', name: '暖白纸张', description: '暖白底色 · 深棕文字', dark: false, colors: {
    bg: '#faf7f1', surface: '#faf7f1', text: '#3d3730', muted: '#6f675d', line: '#ded8ce', accent: '#0e6e63', soft: '#e3ebe4', danger: '#ad4541', code: '#eeeae2',
    sidebar: '#f1ede5', input: '#eae6dd', bubble: '#ece7de', composer: '#f4f0e8', composerBorder: '#ded8cd',
    faint: '#938a7c', timestamp: '#938a7c', ring: '#d1c9bc', subtleLine: '#e2ddd3', question: '#6f675d', questionBg: '#f2eee6', optionBorder: '#b7ae9f',
    success: '#34734b', taskRunning: '#b96b12', online: '#378365', offline: '#a0988c', warningBg: '#f2ead7', warningBorder: '#dac79f',
    taskProjectBg: '#eadfc9', taskThreadBg: '#f4ecdd',
    diffBg: '#f5f1e9', diffAddedBg: '#e1eddc', diffAddedText: '#2e633c', diffDeletedBg: '#f4e1da', diffDeletedText: '#9c3934', diffHunkBg: '#e7e9e5', diffHunkText: '#526778',
    heading: '#2d4767', headingSecondary: '#6d4d8b', syntaxKeyword: '#80558d', syntaxString: '#3b7151', syntaxNumber: '#985522', syntaxTitle: '#0e6e63',
    solid: '#3d3730', onSolid: '#faf7f1', onAccent: '#ffffff', mode: '#dfe8df', jumpBorder: '#d4cdbf', settingsGroup: '#f0ece3', settingsLine: '#dad3c7',
    slider: '#0e6e63', sliderTrack: '#e4ded3', sliderDot: '#bfb5a5', sliderSelectedDot: '#80b7a8', thumb: '#faf7f1', thumbBorder: '#d7cfc0',
    glass: '#f3efe5e8', glassBorder: '#ded7c8', overlay: '#31291d44', shadow: '#3d3022', shimmer: '#91887b', shimmerHighlight: '#554e43',
  } },
  { id: 'warm-dark', name: '中性深色', description: '中性深灰 · 清晰蓝色', dark: true, colors: {
    bg: '#111113', surface: '#111113', text: '#eeeef2', muted: '#95959e', line: '#2d2d32', accent: '#3565f6', soft: '#242a3b', danger: '#ed9890', code: '#242427',
    sidebar: '#18181b', input: '#242427', bubble: '#202c48', composer: '#242427', composerBorder: '#242427',
    faint: '#73737d', timestamp: '#8b8b94', ring: '#534a42', subtleLine: '#33333a', question: '#a99e91', questionBg: '#242427', optionBorder: '#71665a',
    success: '#5cc88a', taskRunning: '#efab54', online: '#7db698', offline: '#84796d', warningBg: '#352b20', warningBorder: '#6a4b2a',
    taskProjectBg: '#372c20', taskThreadBg: '#29231d',
    diffBg: '#1b1b1f', diffAddedBg: '#183125', diffAddedText: '#91d7a8', diffDeletedBg: '#391e26', diffDeletedText: '#f4a3b2', diffHunkBg: '#242b37', diffHunkText: '#b1c5e8',
    heading: '#eeeef2', headingSecondary: '#eeeef2', syntaxKeyword: '#d1a8ef', syntaxString: '#a9d7b7', syntaxNumber: '#e4ba8f', syntaxTitle: '#9dcaf3',
    solid: '#3565f6', onSolid: '#ffffff', onAccent: '#ffffff', mode: '#30443b', jumpBorder: '#38383f', settingsGroup: '#242427', settingsLine: '#3b3b42',
    slider: '#3565f6', sliderTrack: '#35353c', sliderDot: '#6c6c77', sliderSelectedDot: '#9bb1f9', thumb: '#fafaff', thumbBorder: '#938575',
    glass: '#252528', glassBorder: '#35353c', overlay: '#00000077', shadow: '#000000', shimmer: '#898994', shimmerHighlight: '#d4d4df',
  } },
];

export function themeId(value: unknown): ThemeId {
  return controlThemes.some(theme => theme.id === value) ? value as ThemeId : 'default';
}
export function controlTheme(value: unknown): ControlTheme {
  return controlThemes.find(theme => theme.id === value) ?? controlThemes[0]!;
}
