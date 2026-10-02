import type { AuthSettings } from '../../../packages/shared/src/session-policy';
export type { AuthSettings };
export type Account = { id: string; name: string; role: 'admin' | 'user'; revoked_at: number | null; login_enabled: boolean };
const key = 'codexer.admin.session.v2';
let session = '';
try {
  session = localStorage.getItem(key) || '';
  if (!session) { session = sessionStorage.getItem(key) || ''; if (session) localStorage.setItem(key, session); }
  sessionStorage.removeItem(key);
} catch { /* Continue with an in-memory session. */ }

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function clearSession() { session = ''; for (const storage of ['localStorage', 'sessionStorage'] as const) { try { globalThis[storage].removeItem(key); } catch { /* Storage is optional. */ } } }
export function hasSession() { return Boolean(session); }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error', ...(path === '/v1/auth/active' ? {keepalive: true} : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) clearSession();
    const message = response.status === 401 ? '账号或密码错误，或登录已失效' : response.status === 403 ? '此入口仅供管理员使用' : response.status === 409 ? '账号名称已存在' : response.status === 429 ? '操作过于频繁，请稍后重试' : response.status === 400 ? '请检查输入的格式和范围' : '服务器暂时不可用，请稍后重试';
    throw new ApiError(response.status, message);
  }
  return result as T;
}
export async function login(username: string, password: string) {
  const result = await request<{ session: string; role: string }>('/v1/auth/login', 'POST', { username, password });
  session = result.session;
  if (result.role !== 'admin') { await logout(); throw new ApiError(403, '此入口仅供管理员使用'); }
  try { localStorage.setItem(key, session); sessionStorage.removeItem(key); } catch { /* Storage is optional. */ }
}
export async function restore() { if (!session) return false; const me = await request<{ role: string }>('/v1/me'); if (me.role !== 'admin') { await logout(); return false; } return true; }
export async function logout() { try { if (session) await request('/v1/auth/logout', 'POST'); } finally { clearSession(); } }
export async function listAccounts() { return (await request<{ users: Account[] }>('/v1/users')).users; }
export const createAccount = (username: string, password: string) => request('/v1/users', 'POST', { username, password });
export const resetPassword = (id: string, password: string) => request(`/v1/users/${encodeURIComponent(id)}/password`, 'PUT', { password });
export const disableAccount = (id: string) => request(`/v1/users/${encodeURIComponent(id)}`, 'DELETE');
export const authSettings = () => request<AuthSettings>('/v1/admin/auth-settings');
export const saveAuthSettings = (settings: AuthSettings) => request<AuthSettings>('/v1/admin/auth-settings', 'PUT', settings);
export const touchLogin = () => request('/v1/auth/active', 'POST');
