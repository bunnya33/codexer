import { filePreviewLimit, filePreviewLimitMessage, type PreviewFileInfo } from './file-preview';

export function fileDocumentKind(name: string): 'pdf' | null {
  const extension = name.replaceAll('\\', '/').split('/').at(-1)?.split('.').slice(1).at(-1)?.toLowerCase();
  if (extension === 'pdf') return 'pdf';
  return null;
}

export function documentPreviewSource(source: { uri: string; headers: Record<string, string> }) {
  const url = new URL(source.uri);
  if (!url.pathname.endsWith('/content')) throw new Error('unsupported-document-source');
  url.searchParams.set('preview', '1');
  return { ...source, uri: url.toString() };
}

export async function readDocumentPDF(response: Response, info: PreviewFileInfo): Promise<Uint8Array> {
  const limit = filePreviewLimit(info);
  if (Number(response.headers.get('content-length')) > limit) throw new Error(filePreviewLimitMessage(info));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error(filePreviewLimitMessage(info));
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('invalid-document-preview');
  return bytes;
}

export function documentPreviewHTML(bytes: Uint8Array, source: string, channel: string): string {
  const base = new URL('/v1/document-runtime/', source).toString();
  // React Native/Hermes does not guarantee the browser btoa global.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', chunks: string[] = [];
  let chunk = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!, b = bytes[offset + 1], c = bytes[offset + 2];
    chunk += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!
      + (b === undefined ? '=' : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!)
      + (c === undefined ? '=' : alphabet[c & 63]!);
    if (chunk.length >= 8192) { chunks.push(chunk); chunk = ''; }
  }
  chunks.push(chunk);
  const config = JSON.stringify({ data: chunks.join(''), base, channel }).replaceAll('<', '\\u003c');
  const escaped = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const csp = `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' ${base}; connect-src ${base}; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escaped(csp)}"></head><body><div id="document-status" role="status">正在打开文档…</div><script>window.codexerDocument=${config};</script><script src="${escaped(base)}viewer.js" crossorigin="anonymous" onerror="document.getElementById('document-status').textContent='文档阅读器加载失败，请更新服务器后重试。'"></script></body></html>`;
}
