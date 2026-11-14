import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { DEFAULT_PREVIEW_MIB, MAX_PREVIEW_MIB, previewSettingsSchema } from '../../../packages/shared/src/preview-settings';
import * as api from './api';

export function PreviewSettings() {
  const [draft, setDraft] = useState(String(DEFAULT_PREVIEW_MIB));
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null), live = useRef(false);
  const load = async () => {
    if (pending.current) return;
    const abort = new AbortController(); pending.current = abort; setBusy(true); setError('');
    try { const value = await api.previewSettings(abort.signal); if (live.current) { setDraft(String(value.maxPreviewMiB)); setLoaded(true); } }
    catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : '读取失败，请重试'); }
    finally { pending.current = null; if (live.current) setBusy(false); }
  };
  useEffect(() => { live.current = true; void load(); return () => { live.current = false; pending.current?.abort(); }; }, []);
  return <form className="card login-settings" aria-label="文件预览设置" noValidate onSubmit={event => {
    event.preventDefault(); if (!loaded || pending.current) return;
    const value = previewSettingsSchema.safeParse({maxPreviewMiB: Number(draft)});
    if (!/^\d+$/.test(draft) || !value.success) { setError(`请填写 1 至 ${MAX_PREVIEW_MIB} 的整数。`); setMessage(''); return; }
    const abort = new AbortController(); pending.current = abort; setBusy(true); setError(''); setMessage('');
    void api.savePreviewSettings(value.data, abort.signal).then(saved => { if (live.current) { setDraft(String(saved.maxPreviewMiB)); setMessage('已保存，下次打开预览时生效。'); } })
      .catch(failure => { if (live.current) setError(failure instanceof Error ? failure.message : '保存失败，请重试'); })
      .finally(() => { pending.current = null; if (live.current) setBusy(false); });
  }}>
    <h2><FileText size={20}/>文件预览</h2>
    <p className="muted">统一设置 HTML 页面、文本和源码的预览大小，HTML 分享也使用此上限。</p>
    <div className="timeout-fields"><label>最大预览大小（MiB）<input aria-label="最大预览大小（MiB）" type="number" min={1} max={MAX_PREVIEW_MIB} step={1} value={draft} onChange={event => setDraft(event.target.value)} disabled={!loaded || busy} required/></label><button className="primary" disabled={!loaded || busy}>保存设置</button>{!loaded && <button type="button" disabled={busy} onClick={() => void load()}>重新读取</button>}</div>
    <p className="footnote">范围 1–{MAX_PREVIEW_MIB} MiB，默认 {DEFAULT_PREVIEW_MIB} MiB。图片、音频和原文件下载沿用各自的传输上限。客户端需更新到支持服务器预览设置的版本。</p>
    {!!error && <p role="alert" className="error">{error}</p>}{!!message && <p role="status">{message}</p>}
  </form>;
}
