import { localTaskTime, recordedTurnTiming } from '../../../packages/client-shared/src/turn-timing';
import { useTheme } from './styles';
import type { TurnTimingProps } from './turn-timing';

export function TurnTiming({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const { start } = recordedTurnTiming(turn, running);
  const startLabel = start ? `开始时间 ${localTaskTime(start)}` : '开始时间未记录';
  return <div data-testid="turn-timing" aria-label={startLabel} style={{ display: 'flex', justifyContent: 'center', padding: '4px 8px 0', color: c.timestamp, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: 12, lineHeight: '18px' }}>
    {start ? <time dateTime={start.toISOString()} title={start.toLocaleString('zh-CN', { timeZoneName: 'short' })} style={{ whiteSpace: 'nowrap' }}>{localTaskTime(start)}</time> : <span title="开始时间未记录">—</span>}
  </div>;
}

export function TurnEndTime({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const { end } = recordedTurnTiming(turn, running);
  if (!end) return null;
  return <time data-testid="turn-end-time" aria-label={`结束时间 ${localTaskTime(end)}`} dateTime={end.toISOString()} title={end.toLocaleString('zh-CN', { timeZoneName: 'short' })} style={{ color: c.timestamp, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: 12, lineHeight: '18px', alignSelf: 'flex-start', textAlign: 'left' }}>{localTaskTime(end)}</time>;
}
