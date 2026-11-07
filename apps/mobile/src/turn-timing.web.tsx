import { localTaskTime, recordedTurnTiming } from '../../../packages/client-shared/src/turn-timing';
import { turnCostLabel } from '../../../packages/client-shared/src/project-usage';
import { useTheme } from './styles';
import type { TurnTimingProps } from './turn-timing';

export function TurnTiming({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const { start } = recordedTurnTiming(turn, running);
  const startLabel = start ? `开始时间 ${localTaskTime(start)}` : '开始时间未记录';
  const active = running || turn.status === 'inProgress';
  return <div data-testid="turn-timing" aria-label={`${active ? '任务进行中' : '任务已结束'}，${startLabel}`} style={{ display: 'flex', justifyContent: 'center', padding: '4px 8px 0', color: c.timestamp, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: 12, lineHeight: '18px' }}>
    {start ? <time dateTime={start.toISOString()} title={start.toLocaleString('zh-CN', { timeZoneName: 'short' })} style={{ whiteSpace: 'nowrap' }}>{localTaskTime(start)}</time> : <span title="开始时间未记录">—</span>}
  </div>;
}

export function TurnEndTime({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const { end } = recordedTurnTiming(turn, running);
  if (!end) return null;
  const value = localTaskTime(end);
  const suffix = turn.status === 'completed' ? ' · 已完成' : '';
  const cost = turn.status === 'completed' ? turnCostLabel(turn.tokenUsage) : '';
  return <time data-testid="turn-end-time" aria-label={`结束时间 ${value}${suffix}${cost ? ` · ${cost}` : ''}`} dateTime={end.toISOString()} title={end.toLocaleString('zh-CN', { timeZoneName: 'short' })} style={{ color: c.timestamp, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: 12, lineHeight: '18px', alignSelf: 'flex-start', textAlign: 'left' }}>{value}{suffix}{!!cost && <span data-testid="turn-cost"> · {cost}</span>}</time>;
}
