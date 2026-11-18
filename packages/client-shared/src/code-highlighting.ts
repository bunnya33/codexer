import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import apache from 'highlight.js/lib/languages/apache';
import asciidoc from 'highlight.js/lib/languages/asciidoc';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cmake from 'highlight.js/lib/languages/cmake';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import latex from 'highlight.js/lib/languages/latex';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { highlightLanguage, type CodeLanguage } from './code-languages.js';
import type { ThemeColors } from './themes.js';

export { codeLanguage } from './code-languages.js';

// Lua files often contain Luau: keep Lua's strings/comments and add its keywords.
const luaWithLuau: LanguageFn = api => {
  const language = lua(api);
  const keywords = language.keywords as Record<string, string>;
  language.keywords = { ...keywords, keyword: `${keywords.keyword} continue export typeof` };
  // `type(...)` stays a Lua built-in; `type Name<T> = ...` is a Luau declaration.
  language.contains?.unshift({ scope: 'keyword', match: /\btype(?=\s+[A-Za-z_]\w*(?:\s*<[^>\r\n]*>)?\s*=)/ });
  return language;
};
const languages = {
  apache, asciidoc, bash, c, cmake, cpp, csharp, css, diff, dockerfile, dos, go, ini, java,
  javascript, json, kotlin, latex, less, lua: luaWithLuau, makefile, markdown, nginx, php,
  powershell, properties, protobuf, python, ruby, rust, scss, sql, swift, text: plaintext, typescript, xml, yaml,
} satisfies Record<CodeLanguage, LanguageFn>;
for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language);

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

export function highlightCode(source: string, info = ''): string {
  const language = highlightLanguage(info);
  return language ? hljs.highlight(source, { language, ignoreIllegals: true }).value : escape(source);
}

export type CodeRun = { text: string; tone?: keyof ThemeColors };
const unescape = (value: string) => value.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" })[entity]!);
function tone(classes: string): CodeRun['tone'] {
  if (/addition/.test(classes)) return 'diffAddedText';
  if (/deletion/.test(classes)) return 'diffDeletedText';
  if (/keyword|selector-tag/.test(classes)) return 'syntaxKeyword';
  if (/string|attr|regexp/.test(classes)) return 'syntaxString';
  if (/number|literal/.test(classes)) return 'syntaxNumber';
  if (/title|built_in|type|section|name/.test(classes)) return 'syntaxTitle';
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
