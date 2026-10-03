import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
function setup(role: string) {
  const values = new Map<string,string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string,value: string) => values.set(key,value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('sessionStorage', {getItem: () => null, removeItem: () => undefined});
  vi.stubGlobal('fetch',vi.fn(async (url: string, _options?: RequestInit) => new Response(JSON.stringify(url.endsWith('/login') ? { session: 'fake-admin-session', role } : url === '/v1/users' ? { users: [] } : { role }),{status:200})));
  return values;
}
it('uses a separate admin session and only account APIs, without loading devices or sockets', async () => {
  const storage = setup('admin'), api = await import('../apps/admin/src/api.js');
  await api.login('admin','fake-password'); expect(storage.get('codexer.admin.session.v2')).toBe('fake-admin-session');
  expect(await api.restore()).toBe(true); await api.listAccounts(); await api.logout(); expect(storage.size).toBe(0);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/v1/admin/auth/login','/v1/me','/v1/users','/v1/auth/logout']);
});
it('restores the persisted admin login after a new page and keeps it on network errors', async () => {
  const storage = setup('admin'); const first = await import('../apps/admin/src/api.js'); await first.login('admin','fake-password');
  vi.resetModules(); const restored = await import('../apps/admin/src/api.js');
  expect(await restored.restore()).toBe(true);
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'));
  await expect(restored.restore()).rejects.toThrow('offline');
  expect(restored.hasSession()).toBe(true);expect(storage.size).toBe(1);
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}',{status:401}));
  await expect(restored.restore()).rejects.toThrow('登录已失效'); expect(storage.size).toBe(0);
});
it('loads and saves the admin timeout without requesting PC data', async () => {
  setup('admin'); const api = await import('../apps/admin/src/api.js');await api.login('admin','fake-password');
  await api.authSettings();await api.saveAuthSettings({idleTimeoutMinutes:60});await api.touchLogin();
  const calls=vi.mocked(fetch).mock.calls;
  expect(calls.map(([url])=>url)).toEqual(['/v1/admin/auth/login','/v1/admin/auth-settings','/v1/admin/auth-settings','/v1/auth/active']);
  expect(calls[2]?.[1]).toMatchObject({method:'PUT',body:JSON.stringify({idleTimeoutMinutes:60})});
});
it('revokes login attempts from regular users at the admin entry', async () => {
  const storage = setup('user'), api = await import('../apps/admin/src/api.js');
  await expect(api.login('member','password')).rejects.toThrow('仅供管理员'); expect(storage.size).toBe(0); expect(api.hasSession()).toBe(false);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/v1/admin/auth/login','/v1/auth/logout']);
});
it('keeps preparation, build and restart as distinct administrator requests',async()=>{
  setup('admin');const api=await import('../apps/admin/src/api.js');await api.login('admin','fake-password');
  await api.updateSettings({method:'git'});await api.updateServer('v0.3.0');await api.updateServer('v0.3.0','build','job-test');await api.updateServer('v0.3.0','restart','job-test');
  const bodies=vi.mocked(fetch).mock.calls.slice(1).map(([,options])=>JSON.parse(options!.body as string));
  expect(bodies).toEqual([{method:'git'},{tag:'v0.3.0',action:'update'},{tag:'v0.3.0',action:'build',jobId:'job-test'},{tag:'v0.3.0',action:'restart',jobId:'job-test'}]);
});
