import { controlTheme } from '../../../../packages/client-shared/src/themes';
import type { ControlTheme } from '../../../../packages/client-shared/src/themes';

const base = controlTheme('default');
export const interactionLight: ControlTheme = {
  ...base, name: '清爽亮色', colors: {
    ...base.colors, text: '#202124', muted: '#7b7d84', faint: '#a9aab0',
    accent: '#3565f6', solid: '#3565f6', slider: '#3565f6', onSolid: '#ffffff',
    bg: '#ffffff', surface: '#ffffff', sidebar: '#f8f8fa', composer: '#f3f3f6',
    input: '#f3f3f6', bubble: '#edf2ff', soft: '#edf1fc', line: '#ebebef',
    composerBorder: '#f3f3f6', glass: '#fcfcfe', glassBorder: '#eeeeF2',
    taskRunning: '#e39529', taskProjectBg: '#fff2df', taskThreadBg: '#fff8ee',
    shimmer: '#9a9ba3', shimmerHighlight: '#535762', sliderTrack: '#f6f6f8',
    sliderSelectedDot: '#91adff', sliderDot: '#d0d0d7', thumbBorder: '#3867ed',
  },
};
export const interactionDark: ControlTheme = {
  ...base, id: 'warm-dark', name: '中性深色', dark: true, colors: {
    ...interactionLight.colors, bg: '#111113', surface: '#111113', sidebar: '#18181b',
    text: '#eeeeF2', muted: '#95959e', faint: '#73737d', timestamp: '#8b8b94',
    input: '#242427', composer: '#242427', composerBorder: '#242427',
    bubble: '#202c48', soft: '#242a3b', line: '#2d2d32', subtleLine: '#33333a',
    code: '#242427', glass: '#252528', glassBorder: '#35353c', overlay: '#00000077',
    success: '#5cc88a', taskRunning: '#efab54', taskProjectBg: '#372c20', taskThreadBg: '#29231d',
    shimmer: '#898994', shimmerHighlight: '#d4d4df', sliderTrack: '#35353c',
    sliderDot: '#6c6c77', sliderSelectedDot: '#9bb1f9', thumb: '#fafaff',
    warningBg: '#352b20', warningBorder: '#6a4b2a', questionBg: '#242427',
    settingsGroup: '#242427', settingsLine: '#3b3b42', heading: '#eeeeF2', headingSecondary: '#eeeeF2',
    diffBg: '#1b1b1f', diffAddedBg: '#183125', diffAddedText: '#91d7a8',
    diffDeletedBg: '#391e26', diffDeletedText: '#f4a3b2', diffHunkBg: '#242b37', diffHunkText: '#b1c5e8',
    syntaxKeyword: '#d1a8ef', syntaxString: '#a9d7b7', syntaxNumber: '#e4ba8f', syntaxTitle: '#9dcaf3',
    shadow: '#000000', jumpBorder: '#38383f',
  },
};
