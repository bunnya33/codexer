export type Account = { id: string; name: string; role: 'admin' | 'user'; revoked_at: number | null; login_enabled: boolean };
const key = 'codexer.admin.session.v2';
let session = '';
try { session = sessionStorage.getItem(key) || ''; } catch { /* Continue with an in-memory session. */ }

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function clearSession() { session = ''; try { sessionStorage.removeItem(key); } catch { /* Storage is optional. */ } }
export function hasSession() { return Boolean(session); }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) clearSession();
    const message = response.status === 401 ? '账号或密码错误，或登录已失效' : response.status === 403 ? '此入口仅供管理员使用' : response.status === 409 ? '账号名称已存在' : response.status === 429 ? '操作过于频繁，请稍后重试' : response.status === 400 ? '请检查账号和密码格式' : '服务器暂时不可用，请稍后重试';
    throw new ApiError(response.status, message);
  }
  return result as T;
}
export async function login(username: string, password: string) {
  const result = await request<{ session: string; role: string }>('/v1/auth/login', 'POST', { username, password });
  session = result.session;
  if (result.role !== 'admin') { await logout(); throw new ApiError(403, '此入口仅供管理员使用'); }
  try { sessionStorage.setItem(key, session); } catch { /* Storage is optional. */ }
}
export async function restore() { if (!session) return false; const me = await request<{ role: string }>('/v1/me'); if (me.role !== 'admin') { await logout(); return false; } return true; }
export async function logout() { try { if (session) await request('/v1/auth/logout', 'POST'); } finally { clearSession(); } }
export async function listAccounts() { return (await request<{ users: Account[] }>('/v1/users')).users; }
export const createAccount = (username: string, password: string) => request('/v1/users', 'POST', { username, password });
export const resetPassword = (id: string, password: string) => request(`/v1/users/${encodeURIComponent(id)}/password`, 'PUT', { password });
export const disableAccount = (id: string) => request(`/v1/users/${encodeURIComponent(id)}`, 'DELETE');
