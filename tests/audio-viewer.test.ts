import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
import { nativeAudioDocument } from '../packages/client-shared/src/audio';

let javascript = '', css = '';
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/audio-viewer.tsx'], outdir: '.local/audio-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}' } });
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
  css = result.outputFiles!.find(file => file.path.endsWith('.css'))?.text ?? '';
});

async function fixture(delayedCreation = false) {
  const requests: { path: string; method: string; body?: string; auth?: string }[] = [], paused: Element[] = [], reset: Element[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let created = 0;
  const dom = new JSDOM(`<style>${css}</style><div id="root"></div>`, { url: 'http://audio.test/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {
    window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    window.HTMLMediaElement.prototype.pause = function() { paused.push(this); };
    window.HTMLMediaElement.prototype.load = function() { reset.push(this); };
    Object.assign(window, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, AbortSignal,
      audioConfig: { url: 'http://audio.test', username: 'fixture', password: 'fixture-password', deviceId: 'pc', threadId: 'thread', paths: ['/fixture/song.wav', '/fixture/song2.mp3'] },
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input), method = init?.method ?? 'GET';
        requests.push({ path: url.pathname, method, body: init?.body?.toString(), auth: (init?.headers as Record<string, string>)?.authorization });
        const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        if (url.pathname === '/v1/auth/login') return response({ session: 'fixture-session' });
        if (url.pathname === '/v1/me') return response({ role: 'user', userId: 'fixture' });
        if (url.pathname === '/v1/devices') return response({ devices: [] });
        if (url.pathname === '/v1/auth/active') return response({});
        if (url.pathname === '/v1/ws/tickets') return response({ ticket: 'fixture-ticket' });
        if (url.pathname.endsWith('/files/info')) return response({ name: url.searchParams.get('path')!.split('/').at(-1), size: 4 * 1024 * 1024, version: 'a'.repeat(64) });
        if (url.pathname.endsWith('/files/audio')) { created++; if (delayedCreation) await gate; return response({ path: '/v1/audio/' + created.toString(16).padStart(64, '0'), expiresAt: Date.now() + 60000 }); }
        if (url.pathname.startsWith('/v1/audio/') && method === 'DELETE') return response({ ok: true });
        throw new Error('unexpected-request:' + url.pathname);
      } });
    class Socket {
      static OPEN = 1; readyState = 0;
      onopen?: () => void; onmessage?: (event: { data: string }) => void;
      constructor() { window.setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(raw: string) { if (JSON.parse(raw).type === 'client.authenticate') window.setTimeout(() => this.onmessage?.({ data: '{"type":"client.authenticated"}' }), 0); }
      close() { this.readyState = 3; }
    }
    Object.assign(window, { WebSocket: Socket });
  } });
  dom.window.eval(javascript);
  const app = (dom.window as unknown as { audioFixture: { ready: Promise<void>; close: () => void; switchThread: (thread: string) => void } }).audioFixture;
  await app.ready;
  await vi.waitFor(() => expect(dom.window.document.querySelectorAll('[data-file-path]').length).toBe(2));
  const open = (index = 0) => (dom.window.document.querySelectorAll<HTMLElement>('[data-file-path]')[index]!).click();
  const closePlayer = () => dom.window.document.querySelector<HTMLElement>('[aria-label="关闭文件"]')!.click();
  return { dom, app, requests, paused, reset, release, open, closePlayer, close: () => { release(); app.close(); dom.window.close(); } };
}

it('plays audio larger than the text limit without downloading it and stops/revokes it on close or thread changes', async () => {
  const f = await fixture();
  try {
    f.open();
    await vi.waitFor(() => expect(f.dom.window.document.querySelector('audio')).not.toBeNull());
    const audio = f.dom.window.document.querySelector('audio')!;
    expect(audio.controls).toBe(true); expect(audio.autoplay).toBe(false); expect(audio.preload).toBe('metadata');
    expect(audio.src).toMatch(/^http:\/\/audio.test\/v1\/audio\/[a-f0-9]{64}$/);
    expect(audio.src).not.toContain('fixture-session');
    expect(f.requests.find(request => request.path.endsWith('/files/audio'))).toMatchObject({ method: 'POST', auth: 'Bearer fixture-session' });
    expect(f.requests.some(request => request.path.endsWith('/files/content'))).toBe(false);
    expect(f.dom.window.document.querySelector('[aria-label="下载文件"]')).not.toBeNull();
    f.closePlayer();
    await vi.waitFor(() => expect(f.requests.filter(request => request.method === 'DELETE').length).toBe(1));
    expect(f.paused).toContain(audio); expect(f.reset).toContain(audio); expect(audio.hasAttribute('src')).toBe(false);
    f.open(1);
    await vi.waitFor(() => expect(f.dom.window.document.querySelector('audio')).not.toBeNull());
    const second = f.dom.window.document.querySelector('audio')!;
    f.app.switchThread('other-thread');
    await vi.waitFor(() => expect(f.requests.filter(request => request.method === 'DELETE').length).toBe(2));
    expect(f.paused).toContain(second);
  } finally { f.close(); }
});

it('revokes a capability created after its viewer has already been closed', async () => {
  const f = await fixture(true);
  try {
    f.open();
    await vi.waitFor(() => expect(f.requests.some(request => request.path.endsWith('/files/audio'))).toBe(true));
    f.closePlayer(); f.release();
    await vi.waitFor(() => expect(f.requests.filter(request => request.method === 'DELETE').length).toBe(1));
    expect(f.dom.window.document.querySelector('audio')).toBeNull();
  } finally { f.close(); }
});

it('shows playback errors with retry and download, and releases the old stream on retry', async () => {
  const f = await fixture();
  try {
    f.open(); await vi.waitFor(() => expect(f.dom.window.document.querySelector('audio')).not.toBeNull());
    f.dom.window.document.querySelector('audio')!.dispatchEvent(new f.dom.window.Event('error'));
    await vi.waitFor(() => expect(f.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('音频暂时无法播放'));
    expect(f.dom.window.document.querySelector('[aria-label="下载文件"]')).not.toBeNull();
    const retry = Array.from(f.dom.window.document.querySelectorAll<HTMLElement>('[role="button"]')).find(element => element.textContent === '重新加载')!;
    retry.click(); await vi.waitFor(() => expect(f.dom.window.document.querySelector('audio')).not.toBeNull());
    expect(f.requests.filter(request => request.path.endsWith('/files/audio')).length).toBe(2);
    expect(f.requests.filter(request => request.method === 'DELETE').length).toBe(1);
  } finally { f.close(); }
});

it('keeps the native player inside a trusted shell without autoplay or HTML from filenames', () => {
  const uri = 'https://relay.example/v1/audio/' + 'a'.repeat(64);
  const dom = new JSDOM(nativeAudioDocument(uri));
  try {
    const audio = dom.window.document.querySelector('audio')!;
    expect(audio.src).toBe(uri); expect(audio.autoplay).toBe(false); expect(audio.controls).toBe(true);
    expect(dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain('media-src ' + uri);
    const escaped = new JSDOM(nativeAudioDocument(uri + '"><img src=x onerror=alert(1)>'));
    expect(escaped.window.document.querySelector('img')).toBeNull(); escaped.window.close();
  } finally { dom.window.close(); }
});
