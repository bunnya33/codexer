import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { FileRegistry } from '../packages/codex-adapter/src/files.js';
import { fileImageMime, fileReaderKind, localFilePath, readableFileText } from '../packages/client-shared/src/file-links.js';
import { renderMarkdown } from '../packages/client-shared/src/markdown.js';
import { FILE_CHUNK_BYTES, MAX_FILE_BYTES, fileRequestSchema } from '../packages/protocol/src/files.js';
import { previewFile } from '../apps/mobile/src/file-transfer.js';

it('renders the exact Windows document citation as a client link and preserves spaces and Chinese names', () => {
  const path = 'D:/UserFiles/Documents/ChatGPT/New project/docs/截图贴图录屏工具-功能文档-v0.1.md';
  const source = `已按官方资料整理好：[查看功能文档 v0.1](<${path}>)`;
  const html = renderMarkdown(source, undefined, true);
  expect(html).toContain(`data-file-path="${path}"`);
  expect(html).toContain('href="#"');
  expect(html).toContain('>查看功能文档 v0.1</a>');
  expect(html).not.toContain('target=');
  expect(renderMarkdown(source)).not.toContain('data-file-path=');
  const unsafe = renderMarkdown('[bad](javascript:alert(1))\n\n![local](file:///C:/private.txt)\n\n[web](https://example.com)', undefined, true);
  expect(unsafe).not.toContain('src=');
  expect(unsafe).not.toContain('javascript:alert(1)"');
  expect(unsafe).toContain('rel="noopener noreferrer"');
});

it('normalizes local citations without accepting network shares or unsafe protocols', () => {
  expect(localFilePath('file:///C:/New%20project/%E6%96%87%E6%A1%A3.md#L2')).toBe('C:/New project/文档.md');
  expect(localFilePath('C:\\docs\\readme.md:12:3')).toBe('C:/docs/readme.md');
  expect(localFilePath('/D:/New%20project/%E6%96%87%E6%A1%A3.md#L12')).toBe('D:/New project/文档.md');
  expect(localFilePath('/D:\\docs\\readme.md:12:3')).toBe('D:/docs/readme.md');
  expect(localFilePath('/home/user/report.txt#L3')).toBe('/home/user/report.txt');
  for (const value of ['file://server/share/a.txt', '//server/a.txt', '\\\\server\\a.txt', 'https://example.com/a.txt', 'javascript:alert(1)', 'relative.txt', '/bad\u0000.txt']) expect(localFilePath(value)).toBeNull();
  expect(fileRequestSchema.safeParse({type:'file.request', requestId:'00000000-0000-4000-8000-000000000001',threadId:'a',path:'/a',offset:0}).success).toBe(false);
});

it('renders Codex Windows links with a leading slash as drive paths', () => {
  const path = 'D:/UserFiles/Documents/ChatGPT/New project/docs/功能与操作说明-Snipaste对标.md';
  const source = `已整理成 [功能与操作说明 · Snipaste 对标](</${path}>)`;
  expect(renderMarkdown(source, undefined, true)).toContain(`data-file-path="${path}"`);
});

it('uses document readers for text and JSON, and requires a download for executables and archives', () => {
  expect(fileReaderKind('文档.MD')).toBe('markdown');
  expect(fileReaderKind('config.json')).toBe('json');
  expect(fileReaderKind('readme.txt')).toBe('text');
  for (const name of ['setup.exe', 'archive.zip', 'archive.7z', 'file.pdf', 'file.docx', 'unknown']) expect(fileReaderKind(name)).toBe('download');
  expect(readableFileText(Buffer.from('{"a":1}'), 'a.json')).toBe('{\n  "a": 1\n}');
  expect(readableFileText(Buffer.from('{invalid'), 'a.json')).toBe('{invalid');
  expect(() => readableFileText(Buffer.from([0xff]), 'a.txt')).toThrow();
  expect(() => readableFileText(Buffer.from('MZ\u0000'), 'a.txt')).toThrow();
});

it('opens image file citations with an image reader, while archives and misleading extensions still require download', () => {
  for (const [name, mime] of Object.entries({
    '截图.PNG':'image/png', 'photo.JPG':'image/jpeg', 'photo.jpeg':'image/jpeg',
    'animation.gif':'image/gif', 'result.webp':'image/webp', 'drawing.svg':'image/svg+xml',
    'icon.ico':'image/x-icon', 'photo.avif':'image/avif', 'bitmap.bmp':'image/bmp',
  })) {
    expect(fileReaderKind(name)).toBe('image');
    expect(fileImageMime(name)).toBe(mime);
  }
  for (const name of ['preview.png.exe','preview.jpg.zip','README.md','unknown','png','file.constructor','file.__proto__']) {
    expect(fileImageMime(name)).toBeNull();
    if (name !== 'README.md') expect(fileReaderKind(name)).toBe('download');
  }
});

it('rejects an incomplete text response and prevents oversized previews before fetching content', async () => {
  const {vi} = await import('vitest');
  const fetcher = vi.fn(async()=>new Response('short'));
  vi.stubGlobal('fetch',fetcher);
  try {
    const source = {uri:'http://127.0.0.1/content',headers:{authorization:'Bearer synthetic'}};
    const info = {name:'a.txt',size:10,version:'a'.repeat(64)};
    await expect(previewFile(source,info,new AbortController().signal)).rejects.toThrow('invalid-file-response');
    fetcher.mockClear();
    await expect(previewFile(source,{...info,size:3*1024*1024},new AbortController().signal)).rejects.toThrow('文件较大');
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('reads only files cited by a message in that thread, in versioned chunks, without embedding bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-files-'));
  try {
    const path = join(directory, '中文 file.txt').replaceAll('\\', '/');
    const citation = process.platform === 'win32' ? '/' + path : path;
    const bytes = Buffer.alloc(FILE_CHUNK_BYTES + 37, 97);
    await writeFile(path, bytes);
    const files = new FileRegistry();
    files.observeTurn('a', {items:[{id:'final',type:'agentMessage',text:`[文档](<${citation}>)`,truncated:false}]});
    const info = await files.read('a', path);
    expect(await files.read('a', citation)).toEqual(info);
    expect(info).toMatchObject({name:'中文 file.txt',size:bytes.length});
    expect(info.base64).toBeUndefined();
    expect(info.offset).toBeUndefined();
    const first = await files.read('a',path,0,info.version), last = await files.read('a',path,FILE_CHUNK_BYTES,info.version);
    expect(Buffer.concat([Buffer.from(first.base64!,'base64'),Buffer.from(last.base64!,'base64')])).toEqual(bytes);
    await expect(files.read('b',path)).rejects.toThrow('file-not-in-thread');
    await expect(files.read('a',join(directory,'secret.txt'))).rejects.toThrow('file-not-in-thread');
    await expect(files.read('a',path,-1,info.version)).rejects.toThrow('invalid-file-offset');
    await writeFile(path,'changed');
    await expect(files.read('a',path,0,info.version)).rejects.toThrow('file-changed');
    const large = await open(path,'w');
    try { await large.truncate(MAX_FILE_BYTES + 1); } finally { await large.close(); }
    await expect(files.read('a',path)).rejects.toThrow('file-too-large');
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('unexpected-test-directory');
    await rm(directory,{recursive:true,force:true});
  }
});
