import { Text, View } from 'react-native';
import { TaskStatusDot } from './task-status-dot';
import { useTheme } from './styles';

export function RunningTaskCount({ count, label }: { count: number; label: string }) {
  const { c } = useTheme();
  if (count < 1) return null;
  return <View testID="running-task-count" accessible accessibilityLabel={`${label}，${count} 个会话运行中`} style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0, gap: 1 }}>
    <TaskStatusDot running />
    {count > 1 && <Text testID="running-task-number" style={{ color: c.taskRunning, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{count}</Text>}
  </View>;
}
