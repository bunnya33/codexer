import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { codeLanguage, codeRuns, highlightCode } from '../packages/client-shared/src/code-highlighting.js';
import { fileCodeFormat, highlightLanguage } from '../packages/client-shared/src/code-languages.js';
import { fileReaderKind } from '../packages/client-shared/src/file-links.js';
import { highlightCode as markdownHighlight, renderMarkdown } from '../packages/client-shared/src/markdown.js';

const document = new JSDOM().window.document;
function fragment(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

// Real samples exercise registration, aliases, escaping and both rendering paths.
const samples = [
  ['main.lua', 'Lua', 'local message = "中文 <>&amp;"\nreturn true\n'],
  ['main.luau', 'Luau', 'export type Result = { ok: boolean }\nlocal ok = true\nif ok then continue end\n'],
  ['main.mjs', 'js', 'const message = "中文 <>&amp;";\n'],
  ['main.mts', 'TS', 'const message: string = "中文 <>&amp;";\n'],
  ['main.py', 'python', 'def greet():\n    return "中文 <>&amp;"\n'],
  ['main.sh', 'shell', 'if true; then\n  echo "中文 <>&amp;"\nfi\n'],
  ['main.psm1', 'pwsh', 'function Test-Greeting { return "中文 <>&amp;" }\n'],
  ['main.cmd', 'batch', '@echo off\nrem 中文 <>&amp;\nset VALUE=1\n'],
  ['main.c', 'c', 'int main(void) { return 1; } /* 中文 <>&amp; */\n'],
  ['main.cpp', 'c++', 'class Result { public: int value = 1; }; // 中文 <>&amp;\n'],
  ['main.cs', 'c#', 'public class Result { public string Value = "中文 <>&amp;"; }\n'],
  ['Main.java', 'java', 'public class Result { String value = "中文 <>&amp;"; }\n'],
  ['main.kts', 'kt', 'val message: String = "中文 <>&amp;"\n'],
  ['main.swift', 'swift', 'let message: String = "中文 <>&amp;"\n'],
  ['main.go', 'golang', 'package main\nvar message = "中文 <>&amp;"\n'],
  ['main.rs', 'rust', 'fn main() { let message = "中文 <>&amp;"; }\n'],
  ['main.rb', 'ruby', 'def greet\n  "中文 <>&amp;"\nend\n'],
  ['main.php', 'php', '<?php function greet() { return "中文 <>&amp;"; }\n'],
  ['query.sql', 'sql', "SELECT '中文 <>&amp;' AS message;\n"],
  ['schema.PROTO', 'proto', 'syntax = "proto3";\nmessage Greeting { string text = 1; } // 中文 <>&amp;\n'],
  ['config.json', 'json', '{ "message": "中文 <>&amp;", "ok": true }\n'],
  ['config.jsonc', 'jsonc', '// 中文 <>&amp;\n{ "ok": true, }\n'],
  ['config.yaml', 'yml', 'message: "中文 <>&amp;"\nok: true\n'],
  ['config.toml', 'toml', '[greeting]\nmessage = "中文 <>&amp;"\n'],
  ['config.ini', 'ini', '[greeting]\nmessage = "中文 <>&amp;"\n'],
  ['.env.local', 'env', 'GREETING="中文 <>&amp;"\n'],
  ['config.properties', 'properties', 'greeting=中文 <>&amp;\n'],
  ['config.xml', 'xml', '<greeting value="中文 &amp;">hello</greeting>\n'],
  ['index.html', 'html', '<h1 title="中文 &amp;">hello</h1>\n'],
  ['App.vue', 'vue', '<template><h1>中文 &amp;</h1></template>\n<script>const count = 1;</script>\n'],
  ['App.svelte', 'svelte', '<script>let count = 1;</script>\n<h1>中文 &amp; {count}</h1>\n'],
  ['style.css', 'css', 'body { color: red; } /* 中文 <>&amp; */\n'],
  ['style.scss', 'scss', '$color: red; body { color: $color; } /* 中文 <>&amp; */\n'],
  ['style.less', 'less', '@color: red; body { color: @color; } /* 中文 <>&amp; */\n'],
  ['Dockerfile', 'docker', 'FROM alpine:3\nRUN echo "中文 <>&amp;"\n'],
  ['Makefile', 'make', 'all:\n\t@echo "中文 <>&amp;"\n'],
  ['CMakeLists.txt', 'cmake', 'cmake_minimum_required(VERSION 3.20)\n# 中文 <>&amp;\n'],
  ['.gitconfig', 'ini', '[user]\nname = "中文 <>&amp;"\n'],
  ['nginx.conf', 'nginxconf', 'server { listen 80; } # 中文 <>&amp;\n'],
  ['.htaccess', 'apacheconf', '# 中文 <>&amp;\nRewriteEngine On\n'],
  ['README.md', 'markdown', '# 中文 <>&amp;\n\n**hello**\n'],
  ['README.adoc', 'adoc', '= 中文 <>&amp;\n\n*hello*\n'],
  ['paper.tex', 'tex', '\\section{中文 <>&amp;}\n'],
  ['change.patch', 'patch', '@@ -1 +1 @@\n-old\n+中文 <>&amp;\n'],
] as const;

it.each(samples)('highlights %s in source readers and Markdown fences (%s)', (name, fence, source) => {
  const language = codeLanguage(name);
  const kind = language === 'markdown' ? 'markdown' : name.endsWith('.json') ? 'json' : 'text';
  expect(fileReaderKind(name)).toBe(kind);
  expect(highlightLanguage(fence)).toBe(language);
  const html = highlightCode(source, language);
  expect(html).toContain('class="hljs-');
  expect(fragment(html).textContent).toBe(source);
  const runs = codeRuns(source, language);
  expect(runs.map(run => run.text).join('')).toBe(source);
  expect(runs.some(run => run.tone)).toBe(true);
  expect(highlightCode(source, fence)).toBe(html);
  expect(markdownHighlight(source, ` ${fence} title=example `)).toBe(html);
  const rendered = renderMarkdown(`\`\`\`${fence}\n${source}\`\`\`\n`);
  expect(rendered).toContain(`<code class="hljs">${html}</code>`);
  const code = fragment(rendered).querySelector('pre > code');
  expect(code?.textContent).toBe(source);
});

it.each([
  ['script.LUA', 'lua'], ['Client.server.luau', 'lua'],
  ['script.cjs', 'javascript'], ['view.jsx', 'javascript'], ['script.cts', 'typescript'], ['view.tsx', 'typescript'],
  ['types.pyi', 'python'], ['window.pyw', 'python'], ['script.bash', 'bash'], ['script.zsh', 'bash'], ['script.ksh', 'bash'],
  ['script.ps1', 'powershell'], ['module.psd1', 'powershell'], ['script.bat', 'dos'],
  ['header.h', 'c'], ['source.C', 'cpp'], ['header.H', 'cpp'], ['header.hpp', 'cpp'], ['header.hh', 'cpp'], ['source.cxx', 'cpp'], ['header.h++', 'cpp'],
  ['script.csx', 'csharp'], ['main.kt', 'kotlin'], ['task.rake', 'ruby'], ['Gemfile', 'ruby'], ['index.phtml', 'php'], ['table.ddl', 'sql'],
  ['config.JSONC', 'json'], ['config.JSON5', 'json'], ['config.yml', 'yaml'], ['app.config', 'xml'],
  ['config.cfg', 'ini'], ['config.conf', 'ini'], ['production.env', 'ini'], ['.env', 'ini'], ['.env.production.local', 'ini'],
  ['.bashrc', 'bash'], ['.profile', 'bash'], ['.zshrc', 'bash'], ['.envrc', 'bash'], ['.gitmodules', 'ini'], ['.editorconfig', 'ini'], ['.prettierrc', 'json'],
  ['.gitignore', 'text'], ['.gitattributes', 'text'], ['.dockerignore', 'text'], ['README', 'text'], ['LICENSE', 'text'],
  ['data.csv', 'text'], ['data.tsv', 'text'], ['README.rst', 'text'], ['README.rest', 'text'], ['notes.txt', 'text'], ['app.log', 'text'],
  ['README.markdown', 'markdown'], ['README.mdown', 'markdown'], ['README.asciidoc', 'asciidoc'],
  ['Containerfile', 'dockerfile'], ['build.dockerfile', 'dockerfile'], ['GNUmakefile', 'makefile'], ['rules.mk', 'makefile'], ['tools.cmake', 'cmake'],
  ['C:\\dir.with.dots\\CMakeLists.txt', 'cmake'], ['/dir.with.dots/DOCKERFILE', 'dockerfile'], ['/dir.with.dots/no-extension', 'text'],
])('maps %s to %s using its basename and exact extension', (path, language) => {
  expect(codeLanguage(path)).toBe(language);
});

it.each(['README.rst', 'data.csv', 'data.tsv', 'notes.txt', 'app.log', '.gitignore', '.gitattributes'])('safely falls back to plain text for %s', path => {
  const source = '<script>globalThis.__codePreviewExecuted = true</script>\n中文 &amp; &#39;\t\n';
  expect(fileReaderKind(path)).toBe('text');
  expect(codeLanguage(path)).toBe('text');
  const html = highlightCode(source, codeLanguage(path));
  expect(fragment(html).children).toHaveLength(0);
  expect(fragment(html).textContent).toBe(source);
  expect(codeRuns(source, 'text').map(run => run.text).join('')).toBe(source);
});

it('uses explicit allowlists for unknown filenames and fence labels, including object prototype names', () => {
  for (const value of ['unknown', 'lua', 'txt', '.unknown', '.lua', 'folder.lua/unknown', 'C:\\folder.lua\\unknown', 'file.exe', 'file.luac', 'file.lua.exe', '.env.exe', 'constructor', '__proto__', 'toString', 'file.constructor']) {
    expect(fileCodeFormat(value), value).toBeNull();
    expect(codeLanguage(value), value).toBe('text');
    expect(fileReaderKind(value), value).toBe('download');
  }
  const source = '<script>alert("never run")</script> &amp; &#x27; 中文\n';
  for (const info of ['', 'unknown', 'constructor', '__proto__', 'toString', 'lua"onclick="alert(1)']) {
    expect(highlightLanguage(info)).toBeNull();
    const html = highlightCode(source, info);
    expect(fragment(html).children).toHaveLength(0);
    expect(fragment(html).textContent).toBe(source);
    const rendered = fragment(renderMarkdown(`\`\`\`${info}\n${source}\`\`\`\n`));
    expect(rendered.querySelector('script, [onclick]')).toBeNull();
    expect(rendered.querySelector('pre > code')?.textContent).toBe(source);
  }
});

it.each(['lua', 'luau'])('highlights Luau keywords in both .lua and .luau contexts (%s)', language => {
  const source = 'export type Result<T> = typeof(value)\nif ready then continue end\n';
  const html = highlightCode(source, language);
  for (const keyword of ['export', 'type', 'typeof', 'if', 'then', 'continue', 'end']) expect(html).toContain(`<span class="hljs-keyword">${keyword}</span>`);
  expect(highlightCode('local kind = type(value)', language)).toContain('<span class="hljs-built_in">type</span>');
  expect(codeRuns(source, language).map(run => run.text).join('')).toBe(source);
});

it.each(samples)('preserves CRLF, tabs, empty lines, entities and Unicode in native %s highlighting', (_name, language, sample) => {
  const source = '\r\n\t' + sample.replaceAll('\n', '\r\n') + '\r\n<&amp; &lt; &#39; &#x27; "\' 😀 e\u0301>\r\n\r\n';
  expect(codeRuns(source, language).map(run => run.text).join('')).toBe(source);
});

it('preserves empty and large code when highlighting is skipped', () => {
  expect(codeRuns('', 'luau').map(run => run.text).join('')).toBe('');
  const source = 'local x = "中文 <>&amp;"\r\n'.repeat(7000);
  expect(source.length).toBeGreaterThan(128 * 1024);
  expect(codeRuns(source, 'luau')).toEqual([{ text: source }]);
});
