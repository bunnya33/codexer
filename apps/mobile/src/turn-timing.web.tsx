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

export function TurnTiming({ turn, kind }: TurnTimingProps) {
  const { c } = useTheme();
  // Use the recorded turn timestamps; message, sync and render times are different events.
  const start = recordedDate(turn.startedAtMs);
  const end = recordedDate(turn.completedAtMs);
  const ended = end && (!start || end >= start) ? end : undefined;
  const date = kind === 'start' ? start : ended;
  const label = kind === 'start' ? '开始时间' : '结束时间';
  return <div data-testid="turn-timing" data-timing-kind={kind} aria-label={label} style={{ marginTop: kind === 'start' ? 3 : 0, color: c.muted, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: 12, lineHeight: '18px' }}>
    {date ? <time dateTime={date.toISOString()} title={date.toLocaleString('zh-CN', { timeZoneName: 'short' })}>{localTime(date)}</time> : <span aria-label={`${label}未记录`} title={`${label}未记录`}>—</span>}
  </div>;
}
