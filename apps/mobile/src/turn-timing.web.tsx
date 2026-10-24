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
  // Use the recorded turn timestamps; message, sync and render times are different events.
  const start = recordedDate(turn.startedAtMs);
  const end = running ? undefined : recordedDate(turn.completedAtMs);
  const ended = end && (!start || end >= start) ? end : undefined;
  return <div data-testid="turn-timing" aria-label="任务时间" style={{ display: 'flex', flexWrap: 'wrap', columnGap: 18, rowGap: 4, marginTop: 3, color: c.muted, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: 12, lineHeight: '18px' }}>
    <span>{start ? <>开始于 <time dateTime={start.toISOString()} title={start.toLocaleString('zh-CN', { timeZoneName: 'short' })}>{localTime(start)}</time></> : '开始时间未记录'}</span>
    {!running && <span>{ended ? <>结束于 <time dateTime={ended.toISOString()} title={ended.toLocaleString('zh-CN', { timeZoneName: 'short' })}>{localTime(ended)}</time></> : '结束时间未记录'}</span>}
  </div>;
}
