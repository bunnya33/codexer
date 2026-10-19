import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FlatList, Pressable, Text, View } from 'react-native';
import { ConversationDrawer } from '../../apps/mobile/src/conversation-drawer';
import { ConversationViewport } from '../../apps/mobile/src/conversation-viewport';
import { Directory } from '../../apps/mobile/src/directory';
import { DrawerSwipeArea } from '../../apps/mobile/src/drawer-swipe-area';
import { useTheme } from '../../apps/mobile/src/styles';
import type { DirectoryRow } from '../../packages/client-shared/src/directory';
import type { RelayView } from '../../apps/mobile/src/relay';
import { ConversationScroll } from '../../packages/client-shared/src/conversation-scroll';

const threads = Array.from({ length: 70 }, (_, index) => ({
  type: 'thread' as const, id: `thread-${index}`, title: `会话 ${index}`, active: false, nested: true,
}));
const rows: DirectoryRow[] = [{ type: 'project', id: 'work', name: '滚动验证', expanded: true, active: false, threads }];
const view = { phase: 'connected', devices: [], catalogs: {} } as unknown as RelayView;

function Fixture() {
  const { s } = useTheme();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState('thread-0');
  const [intents, setIntents] = useState(0);
  const scroll = useRef<ConversationScroll | null>(null);
  if (!scroll.current) {
    scroll.current = new ConversationScroll();
    scroll.current.readScroll({ height: 2000, offset: 1500, viewport: 500 });
  }
  const [, render] = useState(0);
  return <View style={s.safe}>
    <ConversationDrawer wide={false} open={open} onOpenChange={setOpen} directory={<Directory
      view={view} deviceId="fixture" threadId={selected} rows={rows} search="" wide={false}
      managing={false} paddingTop={0} paddingBottom={0} setSearch={() => {}} selectDevice={() => {}}
      selectThread={id => { setSelected(id); setOpen(false); }} toggleProject={() => {}} createProject={() => {}} createThread={() => {}}
      threadActions={() => {}} close={() => setOpen(false)} settings={() => {}} refresh={() => {}} />}>
      <DrawerSwipeArea>
        <Pressable accessibilityRole="button" accessibilityLabel="打开会话列表" onPress={() => setOpen(true)} style={s.header}>
          <Text>{selected}</Text>
        </Pressable>
        <ConversationViewport onScrollIntent={direction => { scroll.current!.beginInteraction(direction); setIntents(value => value + 1); }}>
          <FlatList testID="conversation-stream" style={s.stream} contentContainerStyle={s.streamContent}
            data={threads} keyExtractor={item => item.id} renderItem={({ item }) => <View style={s.turn}>
              <Text style={s.agentMessage}>{item.title}：消息滚动验证。{ '长消息，向上滑动查看历史。'.repeat(30) }</Text>
            </View>} />
        </ConversationViewport>
      </DrawerSwipeArea>
      <Text testID="scroll-intents">滚动意图：{intents}</Text>
      <Text testID="following">自动跟随：{String(scroll.current.shouldFollow)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="模拟预览高度更新" onPress={() => {
        scroll.current!.contentSize(2004); scroll.current!.layout(500); render(value => value + 1);
      }}><Text>模拟预览高度更新</Text></Pressable>
    </ConversationDrawer>
  </View>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<Fixture />);
