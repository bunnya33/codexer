import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
function setup(role: string) {
  const values = new Map<string,string>(); vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key), setItem: (key: string,value: string) => values.set(key,value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('fetch',vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/login') ? { session: 'fake-admin-session', role } : url === '/v1/users' ? { users: [] } : { role }),{status:200})));
  return values;
}
it('uses a separate admin session and only account APIs, without loading devices or sockets', async () => {
  const storage = setup('admin'), api = await import('../apps/admin/src/api.js');
  await api.login('admin','fake-password'); expect(storage.get('codexer.admin.session.v2')).toBe('fake-admin-session');
  expect(await api.restore()).toBe(true); await api.listAccounts(); await api.logout(); expect(storage.size).toBe(0);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/v1/auth/login','/v1/me','/v1/users','/v1/auth/logout']);
});
it('revokes login attempts from regular users at the admin entry', async () => {
  const storage = setup('user'), api = await import('../apps/admin/src/api.js');
  await expect(api.login('member','password')).rejects.toThrow('仅供管理员'); expect(storage.size).toBe(0); expect(api.hasSession()).toBe(false);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/v1/auth/login','/v1/auth/logout']);
});
