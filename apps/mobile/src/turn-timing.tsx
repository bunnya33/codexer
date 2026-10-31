import { Text, View } from 'react-native';
import type { HistoryTurn } from '../../../packages/protocol/src/index';
import { localTaskTime, recordedTurnTiming } from '../../../packages/client-shared/src/turn-timing';
import { useTheme } from './styles';

export type TurnTimingProps = { turn: HistoryTurn; running: boolean };

export function TurnTiming({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const { start } = recordedTurnTiming(turn, running);
  const startText = start ? localTaskTime(start) : '—';
  const startLabel = start ? `开始时间 ${startText}` : '开始时间未记录';
  return <View testID="turn-timing" style={{ alignItems: 'center' }}>
    <Text accessibilityLabel={startLabel} style={{ color: c.timestamp, fontSize: 12, lineHeight: 18, maxWidth: '100%', paddingTop: 4, paddingHorizontal: 8 }}>{startText}</Text>
  </View>;
}

export function TurnEndTime({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const { end } = recordedTurnTiming(turn, running);
  if (!end) return null;
  const value = localTaskTime(end);
  return <Text testID="turn-end-time" selectable accessibilityLabel={`结束时间 ${value}`} style={{ color: c.timestamp, fontSize: 12, lineHeight: 18, alignSelf: 'flex-start', textAlign: 'left' }}>{value}</Text>;
}
