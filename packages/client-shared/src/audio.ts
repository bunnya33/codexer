import MarkdownIt from "markdown-it";
import { fileAudioMime, fileName, localFilePath } from "./file-links.js";

export type AudioReference = { source: string; title: string };
export type AudioPart = { kind: "text"; text: string } | { kind: "audio"; audio: AudioReference };
const parser = new MarkdownIt({ html: false });
parser.validateLink = () => true;

export function localAudioPath(source: string): string | null {
  const path = localFilePath(source);
  return path && fileAudioMime(fileName(path)) ? path : null;
}

/** Use Markdown's token boundaries so code, escaped tags and nested paths stay literal. */
function inlineImages(source: string, referenceSource = source) {
  const env = {};
  if (referenceSource !== source) parser.parse(referenceSource, env);
  const blocks = parser.parse(source, env);
  const lines = [0];
  for (let at = 0; at < source.length; at++) if (source[at] === "\n") lines.push(at + 1);
  const images: { start: number; end: number; source: string; title: string }[] = [];
  // Only inline blocks are visible Markdown. Definitions, titles and code
  // must never register a file merely because they contain image-like text.
  for (const block of blocks) {
    if (block.type !== "inline" || !block.map || !block.children?.some(token => token.type === "image")) continue;
    const limit = lines[block.map[1]] ?? source.length;
    let cursor = lines[block.map[0]] ?? source.length;
    const positions: number[] = [];
    for (const line of block.content.split("\n")) {
      const at = source.indexOf(line, cursor);
      if (at < 0 || at + line.length > limit) break;
      for (let i = 0; i < line.length; i++) positions.push(at + i);
      const nextLine = source.indexOf("\n", at + line.length);
      positions.push(nextLine < 0 ? at + line.length : nextLine);
      cursor = nextLine < 0 ? limit : nextLine + 1;
    }
    if (positions.length < block.content.length) continue;
    const state = new parser.inline.State(block.content, parser, env, []);
    while (state.pos < block.content.length) {
      const start = state.pos;
      parser.inline.skipToken(state);
      if (!block.content.startsWith("![", start)) continue;
      const children = parser.parseInline(block.content.slice(start, state.pos), env)[0]?.children;
      const image = children?.length === 1 && children[0]?.type === "image" ? children[0] : undefined;
      if (image) images.push({ start: positions[start]!, end: positions[state.pos - 1]! + 1, source: String(image.attrGet("src") ?? ""), title: image.content });
    }
  }
  return images;
}

/** Supply these definitions to each rendered fragment so download links keep resolving. */
export function markdownReferenceSuffix(source: string): string {
  const env: { references?: Record<string, { href: string; title: string }> } = {};
  parser.parse(source, env);
  const escape = (value: string) => value.replace(/[\\\[\]<>"\n\r]/g, character => character === "\n" || character === "\r" ? " " : "\\" + character);
  const definitions = Object.entries(env.references ?? {}).map(([label, reference]) =>
    `[${escape(label)}]: <${escape(reference.href)}> "${escape(reference.title)}"`,
  );
  return definitions.length ? "\n\n" + definitions.join("\n") : "";
}

export function splitAudioContent(source: string, referenceSource = source): AudioPart[] {
  const parts: AudioPart[] = [];
  let end = 0;
  for (const image of inlineImages(source, referenceSource)) {
    const path = localAudioPath(image.source);
    if (!path) continue;
    if (image.start > end) parts.push({ kind: "text", text: source.slice(end, image.start) });
    parts.push({ kind: "audio", audio: { source: path, title: image.title.slice(0, 160) || fileName(path) } });
    end = image.end;
  }
  if (end < source.length) parts.push({ kind: "text", text: source.slice(end) });
  return parts;
}

export function audioReferences(source: string): AudioReference[] {
  return splitAudioContent(source).flatMap(part => part.kind === "audio" ? [part.audio] : []);
}

/** Move registered pictures into the gallery without removing audio or unrelated tags. */
export function stripInlineImageReferences(source: string, references: string[]): string {
  if (!references.length) return source;
  const registered = new Set(references);
  let text = "", end = 0;
  for (const image of inlineImages(source)) {
    if (!registered.has(image.source) || localAudioPath(image.source)) continue;
    text += source.slice(end, image.start);
    end = image.end;
  }
  return text + source.slice(end);
}

/** Only a trusted player shell is executed; filenames never become HTML. */
export function nativeAudioDocument(uri: string): string {
  const escaped = uri.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${escaped}; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:white}audio{display:block;width:100%}</style></head><body><audio controls preload="metadata" src="${escaped}"></audio><script>var audio=document.querySelector('audio');audio.addEventListener('error',function(){window.ReactNativeWebView.postMessage('audio-error')});audio.addEventListener('ended',function(){window.ReactNativeWebView.postMessage('audio-ended')});</script></body></html>`;
}
