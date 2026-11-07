import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Pressable, Text, View } from 'react-native';
import { ConversationHeader } from '../../apps/mobile/src/conversation-header';
import { TurnView } from '../../apps/mobile/src/conversation';
import { Directory } from '../../apps/mobile/src/directory';
import { ThemeProvider, useControlTheme } from '../../apps/mobile/src/theme';
import type { RelayView } from '../../apps/mobile/src/relay';
import type { HistoryTurn } from '../../packages/protocol/src/index';

const longTitle = '检查任务高亮和标题渐变，末尾多移一个字停一秒，回到开头暂停两秒';
const noop = () => {};
function Fixture() {
  const { theme, selectTheme } = useControlTheme();
  const [running, setRunning] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [usage, setUsage] = useState(true);
  const [parallel, setParallel] = useState(false);
  const [title, setTitle] = useState(longTitle);
  const turn: HistoryTurn = { id: 'turn', status: running ? 'inProgress' : 'completed', truncated: false,
    startedAtMs: 1793966400000, ...(running ? {} : { completedAtMs: 1793966460000 }),
    items: [{ id: 'user', type: 'userMessage', text: '请检查任务状态', truncated: false },
      { id: 'reasoning', type: 'reasoning', text: '正在检查状态与布局', truncated: false }],
    ...(usage ? { tokenUsage: { model: 'gpt-5.3-codex', totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, state: running ? 'running' : 'complete' } as const } : {}),
  };
  const count = running ? parallel ? 2 : 1 : 0;
  const view = { phase: 'connected', devices: [{ id: 'fixture', name: '工作电脑', online: true, platform: 'win32' }], snapshots: { fixture: {
    deviceId: 'fixture', runtime: { connected: true }, threads: { fixture: { status: running ? 'active' : 'idle' }, second: { status: running && parallel ? 'active' : 'idle' } },
  } }, catalogs: {} } as unknown as RelayView;
  const projectUsage = { totalTokens: 9_000_000, totalThreads: 8, knownThreads: 8, recordedTokens: 1_200_000, partial: false,
    models: [{ model: 'gpt-5.3-codex', totalTokens: 1_200_000, inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 200_000 }] };
  return <View style={{ width: '100%', maxWidth: 520, alignSelf: 'center', gap: 16, backgroundColor: theme.colors.bg }}>
    <ConversationHeader title={title} subtitle={`示例项目 · ${running ? '进行中' : '空闲'}`} projectUsage={projectUsage} running={running} deviceId="fixture" threadId="fixture"
      agents={[]} supported synchronized truncated={false} hasTruncatedContent={false} onDrawer={noop} onRefresh={noop} onInfo={noop} />
    <View style={{ paddingHorizontal: 20 }}><TurnView turn={turn} active={running} deviceId="fixture" threadId="fixture" onImage={noop} questionRequestIds={[]} /></View>
    <View style={{ height: 370 }}><Directory view={view} deviceId="fixture" threadId="fixture" rows={[{ type: 'project', id: 'project', name: '示例项目', active: running, runningCount: count, expanded,
      threads: [{ type: 'thread', id: 'fixture', title: '示例会话', active: running, nested: true }, ...(parallel ? [{ type: 'thread' as const, id: 'second', title: '另一个并行任务', active: running, nested: true }] : [])] }]} search="" wide={false} managing={false} paddingTop={0} paddingBottom={0}
      setSearch={noop} selectDevice={noop} selectThread={noop} toggleProject={() => setExpanded(value => !value)} createProject={noop} projectActions={noop} threadActions={noop} close={noop} settings={noop} refresh={noop} /></View>
    <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
      <Pressable accessibilityRole="button" accessibilityLabel="切换任务状态" onPress={() => setRunning(value => !value)}><Text>切换任务状态</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="切换并行会话" onPress={() => setParallel(value => !value)}><Text>切换并行会话</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="切换 Token 数据" onPress={() => setUsage(value => !value)}><Text>切换 Token 数据</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="切换标题长度" onPress={() => setTitle(value => value === longTitle ? '短标题' : longTitle)}><Text>切换标题长度</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="切换主题" onPress={() => selectTheme(theme.id === 'default' ? 'paper' : theme.id === 'paper' ? 'warm-dark' : 'default')}><Text>切换主题</Text></Pressable>
    </View>
  </View>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<ThemeProvider><Fixture /></ThemeProvider>);
Object.assign(window, { taskStatusFixture: { close: () => root.unmount() } });
