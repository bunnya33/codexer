import { useEffect, useRef, useState } from 'react';
import { Activity, Cpu, HardDrive, MemoryStick, RefreshCw } from 'lucide-react';
import * as api from './api';
import type { ServerResources } from './api';

export const bytes = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)));
  return `${(value / 1024 ** index).toLocaleString('zh-CN', { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
};
const percent = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)}%`;
function Meter({ value, label }: { value: number | null | undefined; label: string }) {
  return <div className={'resource-meter ' + (value != null && value >= 90 ? 'high' : '')} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(value == null ? { 'aria-valuetext': '暂无数据' } : { 'aria-valuenow': value })}><span style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}/></div>;
}

export function ServerResourcesPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [data, setData] = useState<ServerResources | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [seconds, setSeconds] = useState(30);
  const refresh = useRef(() => {}), expired = useRef(onUnauthorized); expired.current = onUnauthorized;
  useEffect(() => {
    let disposed = false, pending = false, resume = false, timer: ReturnType<typeof setTimeout>, controller: AbortController | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const load = async () => {
      if (disposed || pending || !visible()) return;
      clearTimeout(timer); pending = true; setLoading(true);
      controller = new AbortController();
      let warmup = false;
      try {
        const value = await api.serverResources(controller.signal);
        if (disposed || controller.signal.aborted) return;
        setData(value); setError(''); warmup = value.cpuSampling;
      } catch (value) {
        if (disposed || controller.signal.aborted) return;
        if (value instanceof api.ApiError && value.status === 401) { expired.current(); return; }
        setError('状态刷新失败，显示的是上次采样。请检查连接后重试。');
      } finally {
        pending = false;
        if (!disposed) {
          setLoading(false);
          if (visible()) {
            if (resume) { resume = false; void load(); }
            else timer = setTimeout(() => void load(), warmup ? 2000 : seconds * 1000);
          }
        }
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!visible()) controller?.abort();
      else if (pending) resume = true;
      else void load();
    };
    refresh.current = () => void load();
    document.addEventListener('visibilitychange', visibility);
    void load();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [seconds]);
  const host = data?.host, proc = data?.process, memory = host?.memory;
  const processMemory = memory && proc?.rssBytes != null ? proc.rssBytes / memory.totalBytes * 100 : null;
  return <section className="card server-resources" aria-label="服务器资源状态" aria-busy={loading}>
    <div className="resource-heading"><div><h2><Activity size={20}/>服务器资源</h2><p className="muted">整机状态与 Codexer 进程占用</p></div><div className="resource-actions"><select aria-label="状态刷新周期" value={seconds} onChange={event => setSeconds(Number(event.target.value))}><option value={30}>每 30 秒刷新</option><option value={60}>每 1 分钟刷新</option></select><button aria-label="刷新服务器状态" disabled={loading} onClick={() => refresh.current()}><RefreshCw size={16} className={loading ? 'spinning' : ''}/>刷新</button></div></div>
    <div className="resource-status" role="status">{error ? <span className="error">{data ? error : '服务器状态暂不可用，请稍后重试。'}</span> : data ? <span><span className="tiny-dot"/>最近采样 {new Date(data.capturedAt).toLocaleTimeString('zh-CN')}{data.cpuSampling ? ' · CPU 正在首次采样…' : ''}</span> : <span>正在读取服务器状态…</span>}<span>{host ? `${({ linux: 'Linux', darwin: 'macOS', windows: 'Windows' } as Record<string, string>)[host.platform] ?? host.platform} · ${host.logicalCpus || '—'} 逻辑核心` : ''}</span></div>
    <div className="resource-grid">
      <article className="resource-tile"><h3><Cpu size={17}/>CPU</h3><div className="resource-value"><span>整机</span><strong>{percent(host?.cpuPercent)}</strong></div><Meter label="整机 CPU 使用率" value={host?.cpuPercent}/><div className="resource-value secondary"><span>Codexer</span><strong>{percent(proc?.cpuPercent)}</strong></div><Meter label="Codexer CPU 使用率" value={proc?.cpuPercent}/><p className="muted">均占整机总算力{data?.sampleWindowSeconds != null ? ` · 最近 ${Math.round(data.sampleWindowSeconds)} 秒均值` : ''}</p></article>
      <article className="resource-tile"><h3><MemoryStick size={17}/>内存</h3><div className="resource-value"><span>整机已用</span><strong>{percent(memory?.usedPercent)}</strong></div><Meter label="整机内存使用率" value={memory?.usedPercent}/><p className="resource-detail">{bytes(memory?.usedBytes)} / {bytes(memory?.totalBytes)}<span>可用 {bytes(memory?.availableBytes)}</span></p><div className="resource-value secondary"><span>Codexer 驻留内存</span><strong>{bytes(proc?.rssBytes)}</strong></div><Meter label="Codexer 内存占整机比例" value={processMemory}/><p className="muted">Go 堆 {bytes(proc?.heapBytes)} · {proc?.goroutines ?? '—'} 个协程</p></article>
      <article className="resource-tile"><h3><HardDrive size={17}/>磁盘空间</h3>{data?.disks.length ? data.disks.map(item => <div className="resource-disk" key={item.mount}><div className="resource-value"><span>{item.label}</span><strong>{percent(item.usedPercent)}</strong></div><Meter label={`${item.label}使用率`} value={item.usedPercent}/><p className="resource-detail">已用 {bytes(item.usedBytes)} / {bytes(item.totalBytes)}<span>可用 {bytes(item.availableBytes)}</span><span className="disk-mount" title={item.mount}>{item.mount}{item.filesystem ? ` · ${item.filesystem}` : ''}</span></p></div>) : <p className="muted">{data ? '暂无法读取磁盘信息' : '—'}</p>}</article>
    </div>
    <p className="resource-footnote">仅显示系统分区与数据目录所在分区，不扫描文件。切到后台或离开仪表盘暂停刷新；不可读取的指标显示“—”。容器部署显示运行环境可见的资源，可能与宿主机或容器限额不同。</p>
  </section>;
}
