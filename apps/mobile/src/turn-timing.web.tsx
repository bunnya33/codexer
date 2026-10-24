import { useState } from 'react';
import { useTheme } from './styles';
import type { TurnTimingProps } from './turn-timing';

function recordedDate(value: number | undefined) {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
function localTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function TurnTiming({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const [showEnd, setShowEnd] = useState(false);
  // Use the recorded turn timestamps; message, sync and render times are different events.
  const start = recordedDate(turn.startedAtMs);
  const end = running ? undefined : recordedDate(turn.completedAtMs);
  const ended = end && (!start || end >= start) ? end : undefined;
  const missingEnd = running ? '尚未结束' : '结束时间未记录';
  const startLabel = start ? `开始时间 ${localTime(start)}` : '开始时间未记录';
  const endLabel = ended ? `结束时间 ${localTime(ended)}` : missingEnd;
  const action = showEnd ? '仅显示开始时间' : '显示开始和结束时间';
  return <div data-testid="turn-timing" style={{ display: 'flex', justifyContent: 'center', color: c.timestamp, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: 12, lineHeight: '18px' }}>
    <button type="button" aria-pressed={showEnd} aria-label={`${startLabel}${showEnd ? `，${endLabel}` : ''}，点击${action}`} title={`点击${action}`} onClick={() => setShowEnd(value => !value)} style={{ display: 'inline-flex', justifyContent: 'center', flexWrap: 'wrap', columnGap: 7, rowGap: 4, maxWidth: '100%', padding: '4px 8px', border: 0, borderRadius: 4, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' }}>
      {start ? <time dateTime={start.toISOString()} title={start.toLocaleString('zh-CN', { timeZoneName: 'short' })} style={{ whiteSpace: 'nowrap' }}>{localTime(start)}</time> : <span title="开始时间未记录">—</span>}
      {showEnd && <span style={{ display: 'inline-flex', gap: 7 }}><span aria-hidden="true">→</span>{ended ? <time dateTime={ended.toISOString()} title={ended.toLocaleString('zh-CN', { timeZoneName: 'short' })} style={{ whiteSpace: 'nowrap' }}>{localTime(ended)}</time> : <span title={missingEnd}>—</span>}</span>}
    </button>
  </div>;
}
