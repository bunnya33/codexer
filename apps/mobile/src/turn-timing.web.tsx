import { useState } from 'react';
import { localTaskTime, recordedTurnTiming } from '../../../packages/client-shared/src/turn-timing';
import { useTheme } from './styles';
import type { TurnTimingProps } from './turn-timing';

export function TurnTiming({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const [showEnd, setShowEnd] = useState(false);
  const { start, end: ended } = recordedTurnTiming(turn, running);
  const missingEnd = running ? '尚未结束' : '结束时间未记录';
  const startLabel = start ? `开始时间 ${localTaskTime(start)}` : '开始时间未记录';
  const endLabel = ended ? `结束时间 ${localTaskTime(ended)}` : missingEnd;
  const action = showEnd ? '仅显示开始时间' : '显示开始和结束时间';
  return <div data-testid="turn-timing" style={{ display: 'flex', justifyContent: 'center', color: c.timestamp, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: 12, lineHeight: '18px' }}>
    <button type="button" aria-pressed={showEnd} aria-label={`${startLabel}${showEnd ? `，${endLabel}` : ''}，点击${action}`} title={`点击${action}`} onClick={() => setShowEnd(value => !value)} style={{ display: 'inline-flex', justifyContent: 'center', flexWrap: 'wrap', columnGap: 7, rowGap: 4, maxWidth: '100%', padding: '4px 8px 0', border: 0, borderRadius: 4, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' }}>
      {start ? <time dateTime={start.toISOString()} title={start.toLocaleString('zh-CN', { timeZoneName: 'short' })} style={{ whiteSpace: 'nowrap' }}>{localTaskTime(start)}</time> : <span title="开始时间未记录">—</span>}
      {showEnd && <span style={{ display: 'inline-flex', gap: 7 }}><span aria-hidden="true">→</span>{ended ? <time dateTime={ended.toISOString()} title={ended.toLocaleString('zh-CN', { timeZoneName: 'short' })} style={{ whiteSpace: 'nowrap' }}>{localTaskTime(ended)}</time> : <span title={missingEnd}>—</span>}</span>}
    </button>
  </div>;
}
