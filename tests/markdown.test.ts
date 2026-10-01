import { expect, it } from "vitest";
import { renderCodeBlock, renderMarkdown } from "../packages/client-shared/src/markdown.js";

it("renders headings, nested lists, inline formatting and quotes as Markdown", () => {
  const html = renderMarkdown("## Result\n\n**Done** with `turn/list`.\n\n- First\n  - Nested\n\n> Note\n\n~~Old~~");
  expect(html).toContain("<h2>Result</h2>");
  expect(html).toContain("<strong>Done</strong>");
  expect(html).toContain("<code>turn/list</code>");
  expect(html.match(/<ul>/g)).toHaveLength(2);
  expect(html).toContain("<blockquote>");
  expect(html).toContain("<s>Old</s>");
});

it("renders tables in a scroll container and keeps task checkboxes read-only", () => {
  const html = renderMarkdown("| Name | Value |\n| --- | --- |\n| Device | Online |\n\n- [x] Finished\n- [ ] Pending");
  expect(html).toContain('<div class="table-scroll"><table>');
  expect(html).toContain("<td>Online</td>");
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html.match(/disabled=""/g)).toHaveLength(2);
});

it("escapes raw HTML including HTML inside task lists", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n- [x] <svg onload=alert(1)>');
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img ");
  expect(html).not.toContain("<svg ");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;svg onload=alert(1)&gt;");
});

it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "vbscript:alert(1)", "data:text/html,test", "file:///C:/private.txt", "data:image/png;base64,test"])("blocks unsafe Markdown URLs: %s", url => {
  const html = renderMarkdown(`[open](${url})\n\n![image](${url})`);
  expect(html).not.toContain("href=");
  expect(html).not.toContain("src=");
});

it("opens ordinary links safely and supports automatic HTTPS links", () => {
  const html = renderMarkdown("[Docs](https://example.com/docs)\n\nhttps://example.com/api");
  expect(html.match(/target="_blank"/g)).toHaveLength(2);
  expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
});

it("highlights fenced code and supplies a copy button", () => {
  const html = renderMarkdown("```ts\nconst count = 1;\n```\n");
  expect(html).toContain('class="hljs-keyword"');
  expect(html).toContain('data-action="copy-code"');
  expect(html).toContain("count");
});

it("escapes unknown-language code and treats its label as text", () => {
  const html = renderCodeBlock('<img src=x onerror="alert(1)">\n', 'unknown"onclick="alert(1)');
  expect(html).not.toContain("<img ");
  expect(html).toContain("&lt;img");
  expect(html).toContain("&quot;");
  expect(html).not.toContain(' onclick="');
});

it("renders an unfinished fence during streaming", () => {
  const html = renderMarkdown("Answer:\n\n```python\nprint('hello')");
  expect(html).toContain('class="code-block"');
  expect(html).toContain("hello");
});

it("renders registered local image references without granting local URL access to links", () => {
  const src = "C:/agent/image.png";
  const html = renderMarkdown(`![Screenshot](${src})\n\n[local](${src})\n\n![unknown](file:///C:/private.png)`, value => value === src ? '<button data-image-key="safe">Image</button>' : undefined);
  expect(html).toContain('data-image-key="safe"');
  expect(html).not.toContain("src=");
  expect(html).not.toContain("href=");
});
