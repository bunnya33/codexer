import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
type MediaPickerOptions = { imageSlots: number; videoSlots: number };
type MediaSelection = { images: unknown[]; videos: { name: string; size: number; mimeType: string; readChunk(offset: number, length: number): Promise<string> }[] };

const bundles: Record<string, string> = {};
beforeAll(async () => {
  for (const platform of ['web', 'native', 'desktop']) {
    const entry = platform === 'desktop' ? 'apps/control-native/src/adapters/media-picker.ts' : `apps/mobile/src/media-picker${platform === 'web' ? '.web' : ''}.ts`;
    const result = await build({ stdin: { contents: `import {pickMedia} from './${entry}';window.pickMedia=pickMedia;`, resolveDir: process.cwd() },
      bundle: true, write: false, platform: 'browser', format: 'iife', plugins: [{ name: 'system-pickers', setup(builder) {
        builder.onResolve({ filter: /^(expo-document-picker|expo-image-picker|expo-file-system\/legacy|\.\.\/bridge)$/ }, args => ({ path: args.path, namespace: 'system' }));
        builder.onLoad({ filter: /.*/, namespace: 'system' }, ({ path }) => ({ contents: path === 'expo-document-picker' ? 'export const getDocumentAsync=window.choose;' : path === 'expo-image-picker' ? 'export const launchImageLibraryAsync=window.choose;' : path === '../bridge' ? 'export const request=window.nativeRequest;' : 'export const getInfoAsync=window.fileInfo;export const readAsStringAsync=window.readChunk;export const EncodingType={Base64:"base64"};' }));
      } }] });
    bundles[platform] = result.outputFiles[0]!.text;
  }
});

function fixture(platform: string) {
  const dom = new JSDOM('', { runScripts: 'dangerously' });
  const choose = vi.fn(), readChunk = vi.fn(), fileInfo = vi.fn(), nativeRequest = vi.fn();
  Object.assign(dom.window, { choose, readChunk, fileInfo, nativeRequest,
    Image: class { naturalWidth = 3; naturalHeight = 2; onload?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()); } } });
  dom.window.eval(bundles[platform]!);
  const pick = (dom.window as unknown as { pickMedia(options: MediaPickerOptions): Promise<MediaSelection> }).pickMedia;
  return { dom, pick, choose, readChunk, fileInfo, nativeRequest };
}

it('selects photos and videos together on web, reading only requested video chunks', async () => {
  const f = fixture('web');
  try {
    const image = new f.dom.window.File(['photo'], '照片.png', { type: 'image/png' });
    const video = new f.dom.window.File(['original-video'], '录屏.mp4', { type: 'video/mp4' });
    f.choose.mockResolvedValue({ canceled: false, assets: [{ file: image }, { file: video }] });
    const result = await f.pick({ imageSlots: 20, videoSlots: 4 });
    expect(f.choose).toHaveBeenCalledWith({ multiple: true, base64: false, type: ['image/*', 'video/*'] });
    expect(result.images[0]).toMatchObject({ fileName: '照片.png', base64: Buffer.from('photo').toString('base64'), width: 3, height: 2 });
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({ name: '录屏.mp4', size: 14, mimeType: 'video/mp4' });
    expect(await result.videos[0]!.readChunk(3, 5)).toBe(Buffer.from('ginal').toString('base64'));
  } finally { f.dom.window.close(); }
});

it.each([{ imageSlots: 0, videoSlots: 4, type: ['video/*'] }, { imageSlots: 20, videoSlots: 0, type: ['image/*'] }])('offers only media with remaining slots: %j', async options => {
  const f = fixture('web');
  try {
    f.choose.mockResolvedValue({ canceled: true });
    expect(await f.pick(options)).toEqual({ images: [], videos: [] });
    expect(f.choose.mock.calls[0]![0].type).toEqual(options.type);
    f.choose.mockClear();
    expect(await f.pick({ imageSlots: 0, videoSlots: 0 })).toEqual({ images: [], videos: [] });
    expect(f.choose).not.toHaveBeenCalled();
  } finally { f.dom.window.close(); }
});

it('keeps native video bytes separate from photos and reads the selected URI by offset', async () => {
  const f = fixture('native');
  try {
    const photo = { type: 'image', uri: 'file:///photo.jpg', width: 3, height: 2, base64: 'photo' };
    f.choose.mockResolvedValue({ canceled: false, assets: [photo, { type: 'video', uri: 'file:///video.mp4', fileName: '视频.mp4', mimeType: 'video/mp4' }] });
    f.fileInfo.mockResolvedValue({ exists: true, size: 30_000_000 });
    f.readChunk.mockResolvedValue('chunk');
    const result = await f.pick({ imageSlots: 20, videoSlots: 4 });
    expect(f.choose.mock.calls[0]![0]).toMatchObject({ mediaTypes: ['images', 'videos'], selectionLimit: 24, allowsMultipleSelection: true });
    expect(result.images).toEqual([photo]);
    expect(result.videos[0]).toMatchObject({ name: '视频.mp4', size: 30_000_000 });
    expect(await result.videos[0]!.readChunk(100, 200)).toBe('chunk');
    expect(f.readChunk).toHaveBeenCalledWith('file:///video.mp4', { encoding: 'base64', position: 100, length: 200 });
  } finally { f.dom.window.close(); }
});

it('rejects a native video whose size cannot be read', async () => {
  const f = fixture('native');
  try {
    f.choose.mockResolvedValue({ canceled: false, assets: [{ type: 'video', uri: 'file:///missing.mp4' }] });
    f.fileInfo.mockResolvedValue({ exists: false });
    await expect(f.pick({ imageSlots: 0, videoSlots: 4 })).rejects.toThrow('无法读取视频大小');
  } finally { f.dom.window.close(); }
});

it('converts only desktop photos and streams videos through the existing selected-file bridge', async () => {
  const f = fixture('desktop');
  try {
    f.nativeRequest.mockImplementation(async (method: string) => method === 'pick' ? [
      { path: 'C:/photo.png', uri: 'file:///C:/photo.png', name: 'photo.png', size: 5, mimeType: 'image/png' },
      { path: 'C:/video.mp4', uri: 'file:///C:/video.mp4', name: 'video.mp4', size: 99, mimeType: 'application/octet-stream' },
    ] : method === 'image.convert' ? { base64: 'photo', width: 3, height: 2 } : 'chunk');
    const result = await f.pick({ imageSlots: 20, videoSlots: 4 });
    expect(result.images[0]).toMatchObject({ fileName: 'photo.jpg', mimeType: 'image/jpeg' });
    expect(f.nativeRequest.mock.calls.filter(call => call[0] === 'image.convert')).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({ name: 'video.mp4', size: 99 });
    await result.videos[0]!.readChunk(5, 10);
    expect(f.nativeRequest).toHaveBeenLastCalledWith('readChunk', { path: 'C:/video.mp4', position: 5, length: 10 });
  } finally { f.dom.window.close(); }
});
