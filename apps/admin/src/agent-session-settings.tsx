import { useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';
import { DEFAULT_AGENT_SESSION_DAYS, MAX_AGENT_SESSION_DAYS } from '../../../packages/shared/src/session-policy';

export function AgentSessionSettings({ days, busy, save }: { days: number | null; busy: boolean; save: (days: number) => Promise<void> }) {
  const [duration, setDuration] = useState(String(DEFAULT_AGENT_SESSION_DAYS));
  const [never, setNever] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (days !== null) { setNever(days === 0); if (days > 0) setDuration(String(days)); setError(''); }
  }, [days]);
  return <form className="card login-settings" aria-label="PC Agent 登录有效期设置" onSubmit={event => {
    event.preventDefault();
    const value = never ? 0 : Number(duration);
    if (!never && (!Number.isInteger(value) || value < 1 || value > MAX_AGENT_SESSION_DAYS)) {
      setError(`有效期须为 1 至 ${MAX_AGENT_SESSION_DAYS} 天，或选择永不过期。`); return;
    }
    setError(''); void save(value);
  }}>
    <h2><Monitor size={20}/>PC Agent 登录有效期</h2>
    <p className="muted">设置电脑连接器每次登录的保留时长，方便长期远程控制。有效期从登录时间起计算。</p>
    <div className="timeout-fields">
      <label>到期方式<select aria-label="PC Agent 到期方式" value={never ? 'never' : 'duration'} disabled={days === null || busy} onChange={event => { setNever(event.target.value === 'never'); setError(''); }}>
        <option value="duration">按时长过期</option><option value="never">永不过期</option>
      </select></label>
      {!never && <label>有效天数<input aria-label="PC Agent 有效天数" type="number" min={1} max={MAX_AGENT_SESSION_DAYS} step={1} value={duration} disabled={days === null || busy} required onChange={event => setDuration(event.target.value)}/></label>}
      <button className="primary" disabled={days === null || busy}>保存 PC 登录设置</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <p className="footnote">默认 7 天，可自定义 1 至 {MAX_AGENT_SESSION_DAYS} 天或永不过期。保存后调整仍有效的 PC 登录，已过期的登录需要重新登录。退出登录、重置密码、禁用账号或移除设备仍会使登录失效。</p>
  </form>;
}
