import type { AuthSettings } from '../../../packages/shared/src/session-policy';
export type { AuthSettings };
import type { VersionInfo, UpdateJob, UpdateAction, UpdateSettings } from '../../../packages/shared/src/server-update';
export type { VersionInfo, UpdateJob, UpdateAction, UpdateSettings };
export type Role = 'admin' | 'user';
export type Account = { id: string; name: string; role: Role; created_at: number; revoked_at: number | null; login_enabled: boolean };
export type Overview = {users: number; enabledUsers: number; admins: number; enabledAdmins: number; onlineDevices: number; onlineClients: number; uptime: number};
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
  const response = await fetch(path, { method, headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body ===undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(path.startsWith('/v1/admin/system/version') ? 25000 : 15000), redirect: 'error', ...(path === '/v1/auth/active' ? {keepalive: true} : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) clearSession();
    const codes: Record<string,string> = {'admin-disable-protected':'不能禁用当前账号或最后一位管理员', 'update-in-progress':'已有更新正在进行', 'update-not-current':'版本已变化，请重新检查更新', 'updater-not-installed':'请先用安装器启用服务器更新服务', 'git-updater-not-installed':'请运行新版安装器，启用 Git 构建更新服务', 'git-requires-manual-steps':'Git 更新需要手动确认构建和重启', 'tag-not-available':'该 tag 不可用或不高于当前版本，请重新检查', 'update-step-not-ready':'更新步骤已变化，请刷新后重试', 'account-name-taken':'该类账号的名称已存在'};
    const message = codes[result.error] || (response.status === 401 ? '账号或密码错误，或登录已失效' : response.status === 403 ? '此入口仅供管理员使用' : response.status === 409 ? '操作与当前状态冲突，请刷新后重试' : response.status === 429 ? '操作过于频繁，请稍后重试' : response.status === 400 ? '请检查输入的格式和范围' : '服务器暂时不可用，请稍后重试');
    throw new ApiError(response.status, message);
  }
  return result as T;
}
export async function login(username: string, password: string) {
  const result = await request<{ session: string; role: string }>('/v1/admin/auth/login', 'POST', { username, password });
  session = result.session;
  if (result.role !== 'admin') { await logout(); throw new ApiError(403, '此入口仅供管理员使用'); }
  try { localStorage.setItem(key, session); sessionStorage.removeItem(key); } catch { /* Storage is optional. */ }
}
export async function restore() { if (!session) return false; const me = await request<{ role: string }>('/v1/me'); if (me.role !== 'admin') { await logout(); return false; } return true; }
export async function logout() { try { if (session) await request('/v1/auth/logout', 'POST'); } finally { clearSession(); } }
export async function listAccounts() { return (await request<{ users: Account[] }>('/v1/users')).users; }
const accountsPath = (role: Role) => role === 'admin' ? '/v1/admin/accounts' : '/v1/users';
export const listAdmins = () => request<{users: Account[]; currentUserId: string}>('/v1/admin/accounts');
export const createAccount = (username: string, password: string, role: Role = 'user') => request(accountsPath(role), 'POST', { username, password });
export const resetPassword = (id: string, password: string, role: Role = 'user') => request(`${accountsPath(role)}/${encodeURIComponent(id)}/password`, 'PUT', { password });
export const disableAccount = (id: string, role: Role = 'user') => request(`${accountsPath(role)}/${encodeURIComponent(id)}`, 'DELETE');
export const authSettings = () => request<AuthSettings>('/v1/admin/auth-settings');
export const saveAuthSettings = (settings: AuthSettings) => request<AuthSettings>('/v1/admin/auth-settings', 'PUT', settings);
export const touchLogin = () => request('/v1/auth/active', 'POST');
export const overview = () => request<Overview>('/v1/admin/overview');
export const versionInfo = (force = false) => request<VersionInfo>('/v1/admin/system/version' + (force ? '?force=true' : ''));
export const updateServer = (tag: string, action: UpdateAction = 'update', jobId?: string) => request<UpdateJob>('/v1/admin/system/update','POST',{tag,action,...(jobId ? {jobId} : {})});
export const updateSettings = (settings: boolean | Partial<UpdateSettings>) => request<UpdateSettings>('/v1/admin/system/update-settings','PUT',typeof settings === 'boolean' ? {autoInstall:settings} : settings);
