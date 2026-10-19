import { highlightCode } from './markdown.js';
import type { ThemeColors } from './themes.js';

export type CodeRun = { text: string; tone?: keyof ThemeColors };
const unescape = (value: string) => value.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" })[entity]!);
function tone(classes: string): CodeRun['tone'] {
  if (/keyword|selector-tag/.test(classes)) return 'syntaxKeyword';
  if (/string|attr|regexp/.test(classes)) return 'syntaxString';
  if (/number|literal/.test(classes)) return 'syntaxNumber';
  if (/title|built_in|type/.test(classes)) return 'syntaxTitle';
  if (/comment|quote/.test(classes)) return 'muted';
  return undefined;
}

/** Only parse spans emitted by our highlighter; never interpret source as HTML. */
export function codeRuns(source: string, language: string): CodeRun[] {
  if (source.length > 128 * 1024) return [{ text: source }];
  const html = highlightCode(source, language), stack: CodeRun['tone'][] = [], runs: CodeRun[] = [];
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
    if (match[1] !== undefined) stack.push(tone(match[1]) ?? stack.at(-1));
    else if (match[0] === '</span>') stack.pop();
    else runs.push({ text: unescape(match[2]!), tone: stack.at(-1) });
  }
  return runs;
}

export function codeLanguage(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', ps1: 'powershell', sh: 'bash', yml: 'yaml', html: 'xml', svg: 'xml', md: 'text', txt: 'text' } as Record<string, string>)[extension] ?? extension;
}
