import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { documentPreviewHTML, documentPreviewSource, fileDocumentKind, readDocumentPDF } from '../packages/client-shared/src/document-preview';

it('previews PDFs while leaving Office and disguised executables as downloads', () => {
  expect(fileDocumentKind('C:\\work\\中文.PDF')).toBe('pdf');
  for (const name of ['pdf', 'a.doc', 'a.docx', 'a.xls', 'a.xlsx', 'a.ppt', 'a.pptx', 'a.odt', 'a.ods', 'a.odp', 'a.rtf', 'a.pdf.exe', 'a.xlsx.zip', 'a.docm', 'constructor', 'dir.pdf/unknown']) expect(fileDocumentKind(name)).toBeNull();
});
it('uses the authorized document route for both thread and project files, preserving exact version and root', () => {
  for (const path of ['/v1/devices/d/threads/t/files/content', '/v1/devices/d/projects/p/files/content']) {
    const source = { uri: `https://relay.test${path}?path=${encodeURIComponent('中文 file.docx')}&version=abc&rootIndex=2`, headers: { authorization: 'Bearer synthetic' } };
    const value = documentPreviewSource(source), url = new URL(value.uri);
    expect(url.pathname).toBe(path);
    expect(url.searchParams.get('path')).toBe('中文 file.docx'); expect(url.searchParams.get('rootIndex')).toBe('2'); expect(url.searchParams.get('version')).toBe('abc'); expect(url.searchParams.get('preview')).toBe('1');
    expect(value.headers).toBe(source.headers); expect(source.uri).not.toContain('/document');
  }
});
it('rejects invalid or oversized rendered output independently of the input document size', async () => {
  const info = { name: 'x.docx', size: 4, version: 'a'.repeat(64), previewMaxBytes: 16 };
  expect(await readDocumentPDF(new Response('%PDF-1.7\n%%EOF'), info)).toEqual(new TextEncoder().encode('%PDF-1.7\n%%EOF'));
  await expect(readDocumentPDF(new Response('not PDF'), info)).rejects.toThrow('invalid-document-preview');
  await expect(readDocumentPDF(new Response('%PDF-' + 'x'.repeat(20)), info)).rejects.toThrow('预览上限');
  await expect(readDocumentPDF(new Response('%PDF-', { headers: { 'content-length': '100' } }), info)).rejects.toThrow('预览上限');
});
it('loads only its own Relay assets inside a sandbox-compatible document and never includes auth headers', () => {
  const bytes = new TextEncoder().encode('%PDF-1.7\n<script>never execute</script>\n%%EOF');
  const html = documentPreviewHTML(bytes, 'https://relay.test/v1/devices/d/threads/t/files/content?path=secret.docx', 'document-test');
  const dom = new JSDOM(html);
  const script = dom.window.document.querySelector<HTMLScriptElement>('script[src]')!;
  expect(script.src).toBe('https://relay.test/v1/document-runtime/viewer.js');
  const csp = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
  expect(csp).toContain("object-src 'none'"); expect(csp).toContain("form-action 'none'");
  expect(html).not.toContain('secret.docx'); expect(html).not.toContain('Bearer'); expect(html).not.toContain('never execute');
  expect(Buffer.from(JSON.parse(dom.window.document.querySelector('script')!.textContent!.slice('window.codexerDocument='.length, -1)).data, 'base64')).toEqual(Buffer.from(bytes));
  dom.window.close();
});
it('encodes arbitrary binary PDF bytes and padding without browser-only base64 APIs', () => {
  for (const length of [0, 1, 2, 3, 8191, 8192, 8193]) {
    const bytes = Uint8Array.from({length}, (_, index) => index % 256);
    const html = documentPreviewHTML(bytes, 'https://relay.test', 'test');
    const config = JSON.parse(html.split('window.codexerDocument=')[1]!.split(';</script>')[0]!);
    expect(config.data).toBe(Buffer.from(bytes).toString('base64'));
  }
});
