import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Pressable, Text, View } from 'react-native';
import { ConversationHeader } from '../../apps/mobile/src/conversation-header';
import { TurnView } from '../../apps/mobile/src/conversation';
import { Directory } from '../../apps/mobile/src/directory';
import type { RelayView } from '../../apps/mobile/src/relay';
import type { HistoryTurn } from '../../packages/protocol/src/index';

const longTitle = '检查会话宿主恢复与任务状态显示，并验证长标题滚动后回到开头暂停一秒';
const noop = () => {};
function Fixture() {
  const [running, setRunning] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [usage, setUsage] = useState(true);
  const [title, setTitle] = useState(longTitle);
  const turn: HistoryTurn = { id: 'turn', status: running ? 'inProgress' : 'completed', truncated: false,
    startedAtMs: 1793966400000, ...(running ? {} : { completedAtMs: 1793966460000 }),
    items: [{ id: 'user', type: 'userMessage', text: '请检查任务状态', truncated: false },
      { id: 'reasoning', type: 'reasoning', text: '正在检查状态与布局', truncated: false }],
    ...(usage ? { tokenUsage: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, state: running ? 'running' : 'complete' } as const } : {}),
  };
  const view = { phase: 'connected', devices: [], snapshots: {}, catalogs: {} } as unknown as RelayView;
  return <View style={{ width: '100%', maxWidth: 520, alignSelf: 'center', gap: 16 }}>
    <ConversationHeader title={title} subtitle={`示例项目 · ${running ? '进行中' : '空闲'}`} running={running} deviceId="fixture" threadId="fixture"
      agents={[]} supported synchronized truncated={false} hasTruncatedContent={false} onDrawer={noop} onRefresh={noop} onInfo={noop} />
    <View style={{ paddingHorizontal: 20 }}><TurnView turn={turn} active={running} deviceId="fixture" threadId="fixture" onImage={noop} questionRequestIds={[]} /></View>
    <View style={{ height: 370 }}><Directory view={view} deviceId="fixture" threadId="fixture" rows={[{ type: 'project', id: 'project', name: '示例项目', active: running, expanded,
      threads: [{ type: 'thread', id: 'fixture', title: '示例会话', active: running, nested: true }] }]} search="" wide={false} managing={false} paddingTop={0} paddingBottom={0}
      setSearch={noop} selectDevice={noop} selectThread={noop} toggleProject={() => setExpanded(value => !value)} createProject={noop} projectActions={noop} threadActions={noop} close={noop} settings={noop} refresh={noop} /></View>
    <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
      <Pressable accessibilityRole="button" accessibilityLabel="切换任务状态" onPress={() => setRunning(value => !value)}><Text>切换任务状态</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="切换 Token 数据" onPress={() => setUsage(value => !value)}><Text>切换 Token 数据</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="切换标题长度" onPress={() => setTitle(value => value === longTitle ? '短标题' : longTitle)}><Text>切换标题长度</Text></Pressable>
    </View>
  </View>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<Fixture />);
Object.assign(window, { taskStatusFixture: { close: () => root.unmount() } });
