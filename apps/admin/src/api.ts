import type { AuthSettings } from '../../../packages/shared/src/session-policy';
import {agentReleaseSchema} from '../../../packages/shared/src/agent-release';
import type {AgentRelease} from '../../../packages/shared/src/agent-release';
import {clientReleaseSchema} from '../../../packages/shared/src/client-release';
import type {ClientRelease,ClientTarget} from '../../../packages/shared/src/client-release';
export type { AuthSettings };
import type { VersionInfo, UpdateJob, UpdateAction, UpdateSettings } from '../../../packages/shared/src/server-update';
export type { VersionInfo, UpdateJob, UpdateAction, UpdateSettings };
export type Role = 'admin' | 'user';
export type Account = { id: string; name: string; role: Role; created_at: number; revoked_at: number | null; login_enabled: boolean };
export type Overview = {users: number; enabledUsers: number; admins: number; enabledAdmins: number; onlineDevices: number; onlineClients: number; uptime: number};
export type ServerResources = {
  capturedAt: number; sampleWindowSeconds: number | null; cpuSampling: boolean;
  host: { platform: string; logicalCpus: number; cpuPercent: number | null; memory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number } | null };
  process: { cpuPercent: number | null; rssBytes: number | null; heapBytes: number; goroutines: number; uptimeSeconds: number };
  disks: { label: string; mount: string; filesystem: string; totalBytes: number | null; usedBytes: number | null; availableBytes: number | null; usedPercent: number | null }[];
};
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
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(path.startsWith('/v1/admin/system/version') ? 25000 : 15000);
  const response = await fetch(path, { method, headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body ===undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error', ...(path === '/v1/auth/active' ? {keepalive: true} : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) clearSession();
    const codes: Record<string,string> = {'admin-disable-protected':'不能禁用当前账号或最后一位管理员', 'update-in-progress':'已有更新正在进行', 'update-not-current':'版本已变化，请重新检查更新', 'updater-not-installed':'请先用安装器启用服务器更新服务', 'git-updater-not-installed':'请运行新版安装器，启用 Git 构建更新服务', 'git-requires-manual-steps':'Git 更新需要手动确认构建和重启', 'tag-not-available':'该 tag 不可用或不高于当前版本，请重新检查', 'update-step-not-ready':'更新步骤已变化，请刷新后重试', 'account-name-taken':'该类账号的名称已存在', 'client-upload-in-progress':'已有安装包上传或删除操作，请稍后重试', 'client-release-in-use':'安装包正在下载，请下载完成后再删除', 'client-release-storage-error':'服务器保存失败，请刷新后重试', 'client-release-delete-error':'安装包文件删除失败，请检查服务器存储权限后重试'};
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
export const saveAuthSettings = (settings: Partial<AuthSettings>) => request<AuthSettings>('/v1/admin/auth-settings', 'PUT', settings);
export const touchLogin = () => request('/v1/auth/active', 'POST');
export const agentRelease = async () => {const value=await request<{release:AgentRelease|null}>('/v1/admin/pc-agent/release');return value.release===null?null:agentReleaseSchema.parse(value.release);};
export async function clientReleases(){
  const value=await request<{releases:Record<string,unknown>;packages:unknown[]}>('/v1/admin/client-releases');
  return {releases:Object.fromEntries(Object.entries(value.releases).map(([key,v])=>[key,clientReleaseSchema.parse(v)])),packages:value.packages.map(v=>clientReleaseSchema.parse(v))};
}
export async function deleteClientRelease(release:ClientRelease){
  try { await request('/v1/admin/client-releases/'+encodeURIComponent(release.target)+'/'+encodeURIComponent(release.id),'DELETE'); }
  catch(error) { if(error instanceof ApiError && error.status===404) throw new Error('安装包已被删除，请刷新列表'); throw error; }
}
export function uploadClientRelease(target:ClientTarget,file:File,version:string,buildNumber:number,notes:string,signal:AbortSignal,progress:(value:number)=>void):Promise<ClientRelease>{
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest(),cancel=()=>xhr.abort(),cleanup=()=>signal.removeEventListener('abort',cancel);
  xhr.open('PUT','/v1/admin/client-releases/'+target+'?'+new URLSearchParams({name:file.name,version,buildNumber:String(buildNumber),notes}));xhr.timeout=10*60*1000;xhr.setRequestHeader('Authorization','Bearer '+session);xhr.setRequestHeader('Content-Type','application/octet-stream');
  xhr.upload.onprogress=e=>{if(e.lengthComputable)progress(e.loaded/e.total);};
  xhr.onload=()=>{cleanup();try{const value=JSON.parse(xhr.responseText);if(xhr.status===200){resolve(clientReleaseSchema.parse(value.release));return;}if(xhr.status===401)clearSession();const errors:Record<string,string>={'invalid-client-package':'安装包格式与目标不符','client-upload-in-progress':'已有客户端正在上传','invalid-client-release':'请检查版本、文件名和构建号','client-installer-too-large':'安装包超过 512 MiB','client-release-storage-error':'服务器保存失败，旧版仍然可用'};reject(new Error(errors[value.error]||'上传失败，请重试'));}catch{reject(new Error('服务器返回的安装包信息无效'));}};
  xhr.onerror=()=>{cleanup();reject(new Error('网络错误，请重试'));};xhr.ontimeout=()=>{cleanup();reject(new Error('上传超时，请重试'));};xhr.onabort=()=>{cleanup();reject(new Error('上传已取消'));};
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted){cleanup();reject(new Error('上传已取消'));return;}xhr.send(file);
 });
}
export function uploadAgentRelease(file:File,version:string,signal:AbortSignal,progress:(fraction:number)=>void):Promise<AgentRelease>{
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest(),cancel=()=>xhr.abort();
    const cleanup=()=>signal.removeEventListener('abort',cancel);
    xhr.open('PUT','/v1/admin/pc-agent/release?'+new URLSearchParams({name:file.name,version}));xhr.timeout=10*60*1000;
    xhr.setRequestHeader('Authorization',`Bearer ${session}`);xhr.setRequestHeader('Content-Type','application/octet-stream');
    xhr.upload.onprogress=e=>{if(e.lengthComputable)progress(e.loaded/e.total);};
    xhr.onload=()=>{cleanup();let value:any;try{value=JSON.parse(xhr.responseText);}catch{reject(new Error('服务器返回无效响应'));return;}
      if(xhr.status===200){const parsed=agentReleaseSchema.safeParse(value.release);if(parsed.success)resolve(parsed.data);else reject(new Error('安装包信息无效'));return;}
      if(xhr.status===401)clearSession();
      const messages:Record<string,string>={'invalid-agent-executable':'文件不是有效的 Windows EXE，请选择完整安装包','agent-installer-too-large':'安装包超过 256 MiB','agent-upload-in-progress':'已有安装包正在上传，请稍后重试','agent-upload-incomplete':'上传未完成，请重试','agent-release-storage-error':'服务器保存失败，原安装包保持可用','invalid-agent-release':'请检查版本号和 EXE 文件名'};
      reject(new ApiError(xhr.status,messages[value.error]??(xhr.status===401?'登录已失效，请重新登录':xhr.status===403?'仅管理员可以上传安装包':xhr.status===413?'安装包超过服务器上传限制':'上传失败，请重试')));
    };
    xhr.onerror=()=>{cleanup();reject(new Error('网络暂不可用，上传失败，请重试'));};xhr.ontimeout=()=>{cleanup();reject(new Error('上传超时，请重试'));};xhr.onabort=()=>{cleanup();reject(new Error('上传已取消'));};
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted){cleanup();reject(new Error('上传已取消'));return;}xhr.send(file);
  });
}
export const overview = () => request<Overview>('/v1/admin/overview');
export const serverResources = (signal?: AbortSignal) => request<ServerResources>('/v1/admin/system/resources', 'GET', undefined, signal);
export type ServerLog = {id:number;at:number;level:'info'|'warn'|'error';category:string;code:string;source?:string;initiator?:string;durationMs?:number;connectionId?:string;deviceId?:string;threadId?:string;messageType?:string;agentVersion?:string;seq?:number;messageBytes?:number;threadBytes?:number;threadCount?:number;closeCode?:number;httpStatus?:number;route?:string;sqlState?:string;issues?:{path:string;rule:string}[]};
export type ServerLogPage = {entries:ServerLog[];nextCursor:number|null;retained:number;capacity:number;persistent:boolean;file:string;maxFileBytes:number;fileCount:number;capturedAt:number};
export type ServerLogFilter = {level:string;category:string;deviceId:string;code:string};
export const serverLogs = (filter:ServerLogFilter, before:number|null, signal?:AbortSignal) => {
  const query=new URLSearchParams({limit:'100'});
  for(const [key,value] of Object.entries(filter))if(value.trim())query.set(key,value.trim());
  if(before!==null)query.set('before',String(before));
  return request<ServerLogPage>('/v1/admin/system/logs?'+query,'GET',undefined,signal);
};
export const versionInfo = (force = false) => request<VersionInfo>('/v1/admin/system/version' + (force ? '?force=true' : ''));
export const updateServer = (tag: string, action: UpdateAction = 'update', jobId?: string) => request<UpdateJob>('/v1/admin/system/update','POST',{tag,action,...(jobId ? {jobId} : {})});
export const updateSettings = (settings: boolean | Partial<UpdateSettings>) => request<UpdateSettings>('/v1/admin/system/update-settings','PUT',typeof settings === 'boolean' ? {autoInstall:settings} : settings);
