import {afterEach, expect, it, vi} from 'vitest';
import {previewFile, fileError} from '../apps/mobile/src/file-transfer';
import {filePreviewLimit, previewFileInfoSchema} from '../packages/client-shared/src/file-preview';

afterEach(() => vi.unstubAllGlobals());
it('previews more than 2 MiB using server metadata and marks only preview content requests', async () => {
  const content = '<div>大页面</div>' + ' '.repeat(3 * 1024 * 1024);
  const info = previewFileInfoSchema.parse({name:'large.html', size:Buffer.byteLength(content), version:'a'.repeat(64), previewMaxBytes:32 * 1024 * 1024});
  const fetcher = vi.fn(async (_uri: string, _options?: RequestInit) => new Response(content)); vi.stubGlobal('fetch', fetcher);
  const source = {uri:'https://relay.test/files/content?version=a&path=large.html', headers:{authorization:'Bearer test'}};
  expect(await previewFile(source, info, new AbortController().signal)).toBe(content);
  const url = new URL(fetcher.mock.calls[0]![0] as unknown as string);
  expect(url.searchParams.get('preview')).toBe('1');
  expect(url.searchParams.get('path')).toBe('large.html');
  expect(source.uri).not.toContain('preview=');
  fetcher.mockClear();
  await expect(previewFile(source, {...info, previewMaxBytes:1024 * 1024}, new AbortController().signal)).rejects.toThrow('服务器的 1 MiB');
  expect(fetcher).not.toHaveBeenCalled();
  expect(filePreviewLimit({...info, previewMaxBytes:undefined})).toBe(2 * 1024 * 1024);
});
it('handles a server limit lowered after metadata was fetched', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({error:'file-preview-too-large'}), {status:413})));
  const info = {name:'page.html', size:1, version:'a'.repeat(64), previewMaxBytes:32 * 1024 * 1024};
  await expect(previewFile({uri:'https://relay.test/content',headers:{}}, info, new AbortController().signal)).rejects.toThrow('file-preview-too-large');
  expect(fileError(new Error('file-preview-too-large'))).toContain('服务器当前的预览上限');
});
