import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Clock3, LogOut, RefreshCw, ShieldCheck, UserRoundPlus, Users, X } from 'lucide-react';
import { MAX_IDLE_TIMEOUT_MINUTES } from '../../../packages/shared/src/session-policy';
import * as api from './api';
import type { Account } from './api';
import './style.css';

function App() {
  const [loggedIn, setLoggedIn] = useState(false), [restoring, setRestoring] = useState(true);
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Account | 'new' | null>(null), [newName, setNewName] = useState(''), [newPassword, setNewPassword] = useState('');
  const [disabling, setDisabling] = useState<Account | null>(null);
  const [timeout, setTimeoutValue] = useState('7'), [timeoutUnit, setTimeoutUnit] = useState(1440), [settingsLoaded, setSettingsLoaded] = useState(false);
  const showTimeout = (minutes: number) => {
    const unit = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
    setTimeoutUnit(unit); setTimeoutValue(String(minutes / unit)); setSettingsLoaded(true);
  };
  const refresh = async () => setAccounts(await api.listAccounts());
  const loadSettings = async () => showTimeout((await api.authSettings()).idleTimeoutMinutes);
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const restore = async () => {
      try {
        const valid = await api.restore();
        if (cancelled) return;
        if (valid) { if (document.visibilityState === 'visible') await api.touchLogin(); await Promise.all([refresh(), loadSettings()]); }
        if (!cancelled) { setLoggedIn(valid); setNotice(''); setRestoring(false); }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof api.ApiError && error.status === 401 || !api.hasSession()) { setLoggedIn(false); setRestoring(false); }
        else { setNotice('网络暂不可用，正在恢复登录…'); timer = setTimeout(() => void restore(), 3000); }
      }
    };
    void restore(); return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (!loggedIn) return;
    const active = async () => {
      try { if (document.visibilityState !== 'visible') return; await api.touchLogin(); await refresh(); }
      catch (error) { if (error instanceof api.ApiError && error.status === 401) setLoggedIn(false); }
    };
    const changed = () => { if (document.visibilityState === 'visible') void active(); else void api.touchLogin().catch(() => undefined); };
    const leaving = () => { void api.touchLogin().catch(() => undefined); };
    document.addEventListener('visibilitychange', changed); window.addEventListener('pageshow', changed); window.addEventListener('pagehide', leaving);
    const timer = setInterval(() => void active(), 30000);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', changed); window.removeEventListener('pageshow', changed); window.removeEventListener('pagehide', leaving); };
  }, [loggedIn]);
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setNotice(''); try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); if (error instanceof api.ApiError && error.status === 401) setLoggedIn(false); } finally { setBusy(false); } };
  if (restoring) return <main className="login-shell"><p role="status">{notice || '正在检查登录状态…'}</p></main>;
  if (!loggedIn) return <main className="login-shell"><form className="login-panel" onSubmit={event => { event.preventDefault(); const submitted = password; setPassword(''); void run(async () => { await api.login(username.trim(), submitted); setLoggedIn(true); await Promise.all([refresh(), loadSettings()]); }); }}>
    <div className="brand"><span className="brand-mark"><ShieldCheck size={24}/></span>Codexer<span className="muted">管理后台</span></div><h1>管理员登录</h1><p className="muted">管理账号及访问权限。</p>
    <label>账号<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required maxLength={100}/></label><label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required maxLength={128}/></label>
    {notice && <p role="alert" className="error">{notice}</p>}<button className="primary" disabled={busy || !username.trim() || !password}>{busy ? '正在登录…' : '登录'}</button>
  </form></main>;
  return <div className="admin-app"><header><div className="brand"><span className="brand-mark"><ShieldCheck size={22}/></span>Codexer<span className="muted">账号管理后台</span></div><button onClick={() => void run(async () => { await api.logout(); setLoggedIn(false); setAccounts([]); })}><LogOut size={16}/>退出登录</button></header><main>
    <div className="page-head"><div><h1>账号管理</h1><p className="muted">Web、App 和 PC Agent 使用同一账号登录。</p></div><div className="actions"><button disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={16}/>刷新</button><button className="primary" onClick={() => { setEditing('new'); setNewName(''); setNewPassword(''); }}><UserRoundPlus size={16}/>创建账号</button></div></div>
    {notice && <p className="notice" role="status">{notice}</p>}
    <div className="account-list" aria-label="账号列表"><div className="list-heading"><Users size={17}/>账号<span className="muted">{accounts.length} 个</span></div>{accounts.map(account => <article className="account-row" key={account.id}><div><strong>{account.name}</strong><span className="muted">{account.role === 'admin' ? '管理员' : '普通账号'}</span></div><span className={'badge ' + (account.revoked_at ? 'disabled' : '')}>{account.revoked_at ? '已禁用' : account.login_enabled ? '有效' : '待设置密码'}</span><div className="actions">{account.role !== 'admin' && !account.revoked_at && <><button disabled={busy} onClick={() => { setEditing(account); setNewPassword(''); }}>重置密码</button><button className="danger" disabled={busy} onClick={() => setDisabling(account)}>禁用</button></>}</div></article>)}{!accounts.length && <p className="empty">暂无账号</p>}</div>
    <p className="footnote"><ShieldCheck size={15}/>管理员密码通过服务器命令 <code>sudo codexer password</code> 修改。</p>
    <form className="login-settings" aria-label="登录超时设置" onSubmit={event => {
      event.preventDefault();
      const idleTimeoutMinutes = Number(timeout) * timeoutUnit;
      if (!Number.isInteger(idleTimeoutMinutes) || idleTimeoutMinutes < 1 || idleTimeoutMinutes > MAX_IDLE_TIMEOUT_MINUTES) { setNotice('登录超时须为 1 分钟至 30 天。'); return; }
      void run(async () => { showTimeout((await api.saveAuthSettings({idleTimeoutMinutes})).idleTimeoutMinutes); setNotice('登录超时已保存，对已有登录立即生效。'); });
    }}><h2><Clock3 size={19}/>登录超时</h2><p className="muted">离开页面或 App 超过此时长后，需要重新登录。前台使用时自动续期，手机浏览器回收页面后也可恢复登录。</p><div className="timeout-fields"><label>超时时长<input type="number" min={1} max={MAX_IDLE_TIMEOUT_MINUTES / timeoutUnit} step={1} value={timeout} onChange={event => setTimeoutValue(event.target.value)} disabled={!settingsLoaded || busy} required/></label><label>单位<select aria-label="单位" value={timeoutUnit} onChange={event => setTimeoutUnit(Number(event.target.value))} disabled={!settingsLoaded || busy}><option value={1}>分钟</option><option value={60}>小时</option><option value={1440}>天</option></select></label><button className="primary" disabled={!settingsLoaded || busy}>保存超时设置</button></div><p className="muted">范围 1 分钟至 30 天，默认 7 天。适用于控制端及管理后台；修改会按最后在线时间重新计算现有登录。退出登录、改密或禁用账号仍立即失效。PC Agent 登录不受此设置影响。</p></form>
  </main>
  {editing && <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-label={editing === 'new' ? '创建账号' : '重置密码'} onSubmit={event => { event.preventDefault(); const target = editing, name = newName.trim(), secret = newPassword; setNewPassword(''); void run(async () => { if (target === 'new') await api.createAccount(name, secret); else await api.resetPassword(target.id, secret); setEditing(null); await refresh(); setNotice(target === 'new' ? '账号已创建' : '密码已重置，该账号需要重新登录。'); }); }}><div className="modal-head"><h2>{editing === 'new' ? '创建账号' : `重置 ${editing.name} 的密码`}</h2><button type="button" aria-label="关闭" onClick={() => setEditing(null)}><X size={18}/></button></div>{editing === 'new' && <label>账号名称<input autoFocus value={newName} onChange={event => setNewName(event.target.value)} required maxLength={100}/></label>}<label>新密码<input type="password" autoFocus={editing !== 'new'} value={newPassword} onChange={event => setNewPassword(event.target.value)} minLength={12} maxLength={128} required autoComplete="new-password"/></label><p className="muted">密码为 12 至 128 个字符。重置密码会撤销该账号当前所有登录。</p>{notice && <p role="alert" className="error">{notice}</p>}<div className="actions"><button type="button" onClick={() => setEditing(null)}>取消</button><button className="primary" disabled={busy || newPassword.length < 12 || (editing === 'new' && !newName.trim())}>保存</button></div></form></div>}
  {disabling && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label="禁用账号"><h2>禁用 {disabling.name}？</h2><p>该账号的客户端和 PC Agent 将退出登录，现有数据保留。</p><div className="actions"><button onClick={() => setDisabling(null)}>取消</button><button className="danger" disabled={busy} onClick={() => { const target=disabling; void run(async () => { await api.disableAccount(target.id); setDisabling(null); await refresh(); setNotice('账号已禁用。'); }); }}>确认禁用</button></div></div></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
