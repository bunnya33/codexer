import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { HistoryTurn } from '../../../packages/protocol/src/index';
import { localTaskTime, recordedTurnTiming } from '../../../packages/client-shared/src/turn-timing';
import { useTheme } from './styles';

export type TurnTimingProps = { turn: HistoryTurn; running: boolean };

export function TurnTiming({ turn, running }: TurnTimingProps) {
  const { c } = useTheme();
  const [showEnd, setShowEnd] = useState(false);
  const { start, end } = recordedTurnTiming(turn, running);
  const startText = start ? localTaskTime(start) : '—';
  const endText = end ? localTaskTime(end) : '—';
  const startLabel = start ? `开始时间 ${startText}` : '开始时间未记录';
  const endLabel = end ? `结束时间 ${endText}` : running ? '尚未结束' : '结束时间未记录';
  const textStyle = { color: c.timestamp, fontSize: 12, lineHeight: 18 };
  return <View testID="turn-timing" style={{ alignItems: 'center' }}>
    <Pressable accessibilityRole="button" accessibilityState={{ selected: showEnd }} accessibilityLabel={`${startLabel}${showEnd ? `，${endLabel}` : ''}`} accessibilityHint={showEnd ? '仅显示开始时间' : '显示开始和结束时间'} onPress={() => setShowEnd(value => !value)} hitSlop={4} style={{ maxWidth: '100%', paddingTop: 4, paddingHorizontal: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', columnGap: 7, rowGap: 4 }}>
        <Text style={textStyle}>{startText}</Text>
        {showEnd && <View style={{ flexDirection: 'row', gap: 7 }}><Text style={textStyle}>→</Text><Text style={textStyle}>{endText}</Text></View>}
      </View>
    </Pressable>
  </View>;
}
