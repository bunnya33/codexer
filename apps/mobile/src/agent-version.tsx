import { StyleSheet, Text, View } from 'react-native';
import { themedStyles } from './theme';

export type SelectedAgent = { name: string; online: boolean; agentVersion?: string };

export function AgentVersion({ device }: { device?: SelectedAgent }) {
  const styles = useLocalStyles();
  return <View testID="selected-agent-version" style={styles.field}>
    <Text style={styles.label}>PC Agent 版本</Text>
    <Text selectable style={styles.value}>{device ? `${device.name} · ${device.online ? '在线' : '离线，最后同步'}\n${device.agentVersion ?? '未上报（需更新此设备的 PC Agent）'}` : '尚未选择设备'}</Text>
  </View>;
}

const useLocalStyles = themedStyles(c => StyleSheet.create({
  field: { gap: 6 }, label: { fontSize: 14, color: c.text }, value: { color: c.muted, fontSize: 13, lineHeight: 20 },
}));
