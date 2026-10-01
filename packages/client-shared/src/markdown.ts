import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, css, diff, go, javascript, json, powershell, python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, language);

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(taskLists, { enabled: false });
const escape = markdown.utils.escapeHtml;
const defaultValidateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = value => {
  if (!defaultValidateLink(value)) return false;
  try { return ["http:", "https:", "mailto:"].includes(new URL(value, "https://markdown.invalid/").protocol); }
  catch { return false; }
};

export function renderCodeBlock(source: string, info = ""): string {
  const language = info.trim().split(/\s+/)[0] ?? "";
  const highlighted = hljs.getLanguage(language) ? hljs.highlight(source, { language, ignoreIllegals: true }).value : escape(source);
  return `<div class="code-block"><div class="code-toolbar"><span>${escape(language || "text")}</span><button class="icon-button copy-code" type="button" data-action="copy-code" title="复制代码" aria-label="复制代码">复制</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
}

markdown.renderer.rules.fence = (tokens, index) => renderCodeBlock(tokens[index]!.content, tokens[index]!.info);
markdown.renderer.rules.code_block = (tokens, index) => renderCodeBlock(tokens[index]!.content);
markdown.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
const defaultImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const imageRenderer = env?.imageRenderer as ((source: string) => string | undefined) | undefined;
  const resolved = imageRenderer?.(String(tokens[index]!.attrGet("src") ?? ""));
  if (resolved !== undefined) return resolved;
  tokens[index]!.attrSet("loading", "lazy");
  tokens[index]!.attrSet("referrerpolicy", "no-referrer");
  return defaultImage(tokens, index, options, env, renderer);
};

const renderCache = new Map<string, { html: string; bytes: number }>();
let cachedBytes = 0;
const cacheBudget = 2 * 1024 * 1024;

export function renderMarkdown(source: string, imageRenderer?: (source: string) => string | undefined): string {
  if (imageRenderer) {
    // Register local image URLs only for this render; they never become links.
    const validate = markdown.validateLink;
    try {
      markdown.validateLink = value => imageRenderer(value) !== undefined || validate(value);
      const tokens = markdown.parse(source, {});
      for (const token of tokens) {
        const blocked: boolean[] = [];
        for (const child of token.children ?? []) {
          if (child.type === "link_open") {
            const unsafe = !validate(String(child.attrGet("href") ?? ""));
            blocked.push(unsafe);
            if (unsafe) { child.type = "text"; child.content = ""; }
          } else if (child.type === "link_close" && blocked.pop()) { child.type = "text"; child.content = ""; }
        }
      }
      return markdown.renderer.render(tokens, markdown.options, { imageRenderer });
    } finally { markdown.validateLink = validate; }
  }
  const cached = renderCache.get(source);
  if (cached) return cached.html;
  const html = markdown.render(source);
  const bytes = (source.length + html.length) * 2;
  // Live updates reuse completed messages within a bounded cache.
  if (bytes <= cacheBudget) {
    while (renderCache.size >= 128 || cachedBytes + bytes > cacheBudget) {
      const oldest = renderCache.entries().next().value;
      if (!oldest) break;
      renderCache.delete(oldest[0]); cachedBytes -= oldest[1].bytes;
    }
    renderCache.set(source, { html, bytes }); cachedBytes += bytes;
  }
  return html;
}
