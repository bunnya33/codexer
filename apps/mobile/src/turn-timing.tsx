import { Text, View } from 'react-native';
import type { HistoryTurn } from '../../../packages/protocol/src/index';
import { localTaskTime, recordedTurnTiming } from '../../../packages/client-shared/src/turn-timing';
import { turnCostLabel } from '../../../packages/client-shared/src/project-usage';
import { useTheme } from './styles';

export type TurnTimingProps = { turn: HistoryTurn; running: boolean };

export function TurnTiming({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const { start } = recordedTurnTiming(turn, running);
  const startText = start ? localTaskTime(start) : '—';
  const startLabel = start ? `开始时间 ${startText}` : '开始时间未记录';
  const active = running || turn.status === 'inProgress';
  return <View testID="turn-timing" accessible accessibilityLabel={`${active ? '任务进行中' : '任务已结束'}，${startLabel}`} style={{ alignItems: 'center', paddingTop: 4, paddingHorizontal: 8 }}>
    <Text style={{ color: c.timestamp, fontSize: 12, lineHeight: 18, flexShrink: 1 }}>{startText}</Text>
  </View>;
}

export function TurnEndTime({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const { end } = recordedTurnTiming(turn, running);
  if (!end) return null;
  const value = localTaskTime(end);
  const suffix = turn.status === 'completed' ? ' · 已完成' : '';
  const cost = turn.status === 'completed' ? turnCostLabel(turn.tokenUsage) : '';
  return <Text testID="turn-end-time" selectable accessibilityLabel={`结束时间 ${value}${suffix}${cost ? ` · ${cost}` : ''}`} style={{ color: c.timestamp, fontSize: 12, lineHeight: 18, alignSelf: 'flex-start', textAlign: 'left' }}>{value}{suffix}{!!cost && <Text testID="turn-cost"> · {cost}</Text>}</Text>;
}
