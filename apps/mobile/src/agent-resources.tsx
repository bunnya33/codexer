import {useEffect, useState} from 'react';
import {AppState, Pressable, StyleSheet, Text, View} from 'react-native';
import {Info} from 'lucide-react-native';
import type {AgentProcessResources, AgentResources} from '../../../packages/protocol/src/agent-resources';
import {relay} from './relay';
import {Dialog} from './dialog';
import {useTheme} from './styles';
import {themedStyles} from './theme';

type Reading = {scope: string; value?: AgentResources; receivedAt?: number; error?: string};
const memory = (bytes: number | null) => bytes === null ? '不可用' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const cpu = (value: number | null) => value === null ? '采样中' : `${value.toFixed(1)}%`;
const uptime = (seconds: number | null) => seconds === null ? '不可用' : seconds < 60 ? `${Math.floor(seconds)} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`;

export function useAgentResources(deviceId: string, scope: string, enabled: boolean) {
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [reading, setReading] = useState<Reading>({scope});
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!enabled || !foreground || !deviceId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      let delay = 5000;
      try {
        const value = await relay.agentResources(deviceId, controller.signal);
        if (stopped) return;
        const at = Date.now();
        setReading({scope, value, receivedAt: at}); setClock(at);
        if (value.sampleWindowMs === null) delay = 1000;
      } catch (error) {
        if (stopped) return;
        const message = error instanceof Error ? error.message : '';
        const status = (error as {status?: number} | null)?.status;
        const terminal = message === 'agent-update-required' || status === 404;
        const text = message === 'agent-update-required' ? '更新此设备的 Agent 后可查看' : status === 404 ? '更新服务器后可查看' : '读取失败，正在重试';
        setReading(previous => ({...(previous.scope === scope ? previous : {scope}), error: text}));
        if (terminal) return;
        delay = 10000;
      }
      if (!stopped) timer = setTimeout(() => {void poll();}, delay);
    };
    void poll();
    return () => {stopped = true; controller.abort(); clearTimeout(timer);};
  }, [deviceId, scope, enabled, foreground]);
  return {reading: reading.scope === scope ? reading : {scope}, clock, foreground, tick: setClock};
}

function ProcessCard({process, title, platform}: {process: AgentProcessResources; title: string; platform: string}) {
  const styles = useLocalStyles();
  return <View style={styles.process}>
    <Text style={styles.title}>{title}</Text>
    <View style={styles.metrics}><Text style={styles.metric}>CPU {cpu(process.cpuPercent)}</Text><Text style={styles.metric}>内存 {memory(process.residentBytes)}</Text></View>
    {platform === 'win32' && <Text style={styles.note}>私有提交 {memory(process.privateBytes)}</Text>}
    <Text style={styles.note}>PID {process.pid} · 已运行 {uptime(process.uptimeSeconds)}</Text>
  </View>;
}

export function AgentResourceBar({device, scope, visible, connected}: {
  device: {id: string; name: string; online: boolean; platform: string}; scope: string; visible: boolean; connected: boolean;
}) {
  const {c} = useTheme();
  const styles = useLocalStyles();
  const [open, setOpen] = useState(false);
  const {reading, clock, foreground, tick} = useAgentResources(device.id, scope, visible && connected && device.online);
  useEffect(() => {if (!visible) setOpen(false);}, [visible]);
  useEffect(() => {
    if (!visible || !foreground) return;
    tick(Date.now());
    const timer = setInterval(() => tick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, foreground, tick]);
  const data = reading.value;
  const seconds = reading.receivedAt === undefined ? undefined : Math.max(0, Math.floor((clock - reading.receivedAt) / 1000));
  const stale = !device.online || !connected || (seconds ?? 16) > 15 || !!reading.error;
  const state = !device.online ? '设备离线' : !connected ? '连接已断开' : reading.error ?? (data && stale ? '数据已过期' : '');
  const summary = data ? `CPU ${cpu(data.agent.cpuPercent)} · 内存 ${memory(data.agent.residentBytes)}` : state || 'CPU / 内存读取中…';
  return <>
    <Pressable testID="agent-resource-summary" accessibilityRole="button" accessibilityLabel={`查看 ${device.name} 的 Agent 运行状态，${summary}${data && stale ? '，上次采样' : ''}`} onPress={() => setOpen(true)} style={styles.summary}>
      <Text style={[styles.summaryText, stale && {color: c.muted}]}>{summary}{data && stale ? ' · 上次采样' : ''}</Text><Info size={14} color={c.muted}/>
    </Pressable>
    {open && <Dialog title="Agent 运行状态" onClose={() => setOpen(false)}>
      <Text style={styles.title}>{device.name}</Text>
      {!!state && <Text accessibilityRole="alert" style={styles.note}>{state}{data ? '，以下为上次采样。' : ''}</Text>}
      {data ? <>
        <ProcessCard process={data.agent} title="Agent 本身" platform={device.platform}/>
        <Text style={styles.title}>Agent 启动的 Codex 后台</Text>
        {data.children.length ? data.children.map(process => <ProcessCard key={process.pid} process={process} title={process.name} platform={device.platform}/>) : <Text style={styles.note}>当前未运行独立的 Codex app-server。</Text>}
        <Text style={styles.note}>CPU 以整机总算力 100% 为基准（{data.logicalCpus} 个逻辑处理器）。内存为进程常驻内存{device.platform === 'win32' ? '（Windows 工作集），私有提交单独列出' : ''}。</Text>
        <Text style={styles.note}>仅统计 Agent 本身和它直接启动的 Codex app-server；后者运行的工具进程不计入，官方桌面程序另计。</Text>
        <Text testID="agent-resource-updated" style={styles.note}>采样时间：{new Date(data.capturedAt).toLocaleTimeString()} · {seconds === 0 ? '刚刚更新' : `${seconds} 秒前收到`}</Text>
      </> : <Text style={styles.note}>{state || '正在读取本机采样…'}</Text>}
    </Dialog>}
  </>;
}
const useLocalStyles = themedStyles(c => StyleSheet.create({
  summary: {marginLeft: 43, marginRight: 11, marginBottom: 5, minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6},
  summaryText: {color: c.text, fontSize: 11, flexShrink: 1, lineHeight: 18},
  title: {color: c.text, fontSize: 14, fontWeight: '600'},
  process: {gap: 8, padding: 14, borderRadius: 12, backgroundColor: c.input},
  metrics: {flexDirection: 'row', gap: 16, flexWrap: 'wrap'}, metric: {color: c.text, fontSize: 15},
  note: {color: c.muted, fontSize: 12, lineHeight: 19},
}));
