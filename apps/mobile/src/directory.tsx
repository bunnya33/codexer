import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, FlatList, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { FolderClosed, FolderOpen, MoreHorizontal, RefreshCw, Search, Settings2, SquarePen, X } from 'lucide-react-native';
import type { DirectoryProject, DirectoryRow, DirectoryThread } from '../../../packages/client-shared/src/directory';
import type { RelayView } from './relay';
import { c, directoryThreadHeight, s } from './styles';
import { DevicePicker } from './device-picker';
type Props = { view: RelayView; deviceId: string; threadId: string; rows: DirectoryRow[]; search: string; wide: boolean; managing: boolean; paddingTop: number; paddingBottom: number; setSearch: (value: string) => void; selectDevice: (id: string) => void; selectThread: (id: string) => void; toggleProject: (id: string) => void; createThread: (id: string) => void; threadActions: (thread: { id: string; title: string }) => void; close: () => void; settings: () => void; refresh: () => void };

function RunningIndicator({label}: {label: string}) {
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.loop(Animated.timing(rotation, {toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web'}));
    animation.start(); return () => animation.stop();
  }, [rotation]);
  return <View accessibilityRole="progressbar" accessibilityLabel={label} style={s.runningIndicator}><Animated.View style={[s.runningRing, {transform: [{rotate: rotation.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']})}]}]} /></View>;
}

function ThreadRow({item, props, showActivity = true}: {item: DirectoryThread; props: Props; showActivity?: boolean}) {
  return <View style={[s.threadRow, item.nested && s.threadNested, props.threadId === item.id && s.threadRowSelected]}>
    <Pressable accessibilityRole="button" onPress={() => props.selectThread(item.id)} onLongPress={() => props.threadActions(item)} delayLongPress={450} style={s.threadSelect}><Text numberOfLines={1} style={s.threadName}>{item.title}</Text>{item.active && showActivity && <RunningIndicator label={`正在运行：${item.title}`} />}</Pressable>
    {Platform.OS === 'web' && <Pressable accessibilityRole="button" accessibilityLabel={`管理会话 ${item.title}`} onPress={() => props.threadActions(item)} style={s.projectAction}><MoreHorizontal size={16} color={c.muted} /></Pressable>}
  </View>;
}

function ProjectRow({project, props}: {project: DirectoryProject; props: Props}) {
  const bodyHeight = Math.max(1, project.threads.length) * directoryThreadHeight;
  const height = useRef(new Animated.Value(project.expanded ? bodyHeight : 0)).current;
  const [mounted, setMounted] = useState(project.expanded);
  useEffect(() => {
    if (project.expanded) setMounted(true);
    const animation = Animated.timing(height, {toValue: project.expanded ? bodyHeight : 0, duration: 240, easing: Easing.inOut(Easing.cubic), useNativeDriver: false});
    animation.start(({finished}) => { if (finished && !project.expanded) setMounted(false); });
    return () => animation.stop();
  }, [project.expanded, bodyHeight, height]);
  const FolderIcon = project.expanded ? FolderOpen : FolderClosed;
  const device = props.view.devices.find(item => item.id === props.deviceId);
  return <View testID={`directory-project-${project.id}`}>
    <View style={s.project}>
      <Pressable accessibilityRole="button" aria-expanded={project.expanded} accessibilityLabel={`${project.expanded ? '收起' : '展开'}项目 ${project.name}`} onPress={() => props.toggleProject(project.id)} style={({pressed}) => [s.projectToggle, pressed && s.pressed]}>
        <FolderIcon size={16} strokeWidth={1.6} color={c.muted} /><Text style={s.projectName} numberOfLines={1}>{project.name}</Text>{project.active && !project.expanded && <RunningIndicator label={`项目 ${project.name} 有会话正在运行`} />}
      </Pressable>
      {project.expanded && project.id !== 'unassigned' && <Pressable accessibilityRole="button" accessibilityLabel={`在${project.name}中新建会话`} disabled={props.managing || !device?.online} onPress={() => props.createThread(project.id)} style={({pressed}) => [s.projectAction, pressed && s.pressed, (props.managing || !device?.online) && s.disabled]}><SquarePen size={16} strokeWidth={1.6} color={c.muted} /></Pressable>}
    </View>
    {mounted && <Animated.View testID={`directory-threads-${project.id}`} pointerEvents={project.expanded ? 'auto' : 'none'} aria-hidden={!project.expanded} accessibilityElementsHidden={!project.expanded} importantForAccessibility={project.expanded ? 'auto' : 'no-hide-descendants'} style={[s.projectBody, {height}]}>
      {project.threads.length ? <FlatList data={project.threads} keyExtractor={item => item.id} scrollEnabled={false} initialNumToRender={12} windowSize={5} getItemLayout={(_data, index) => ({length: directoryThreadHeight, offset: directoryThreadHeight * index, index})} style={[s.projectThreads, {height: bodyHeight}]} renderItem={({item}) => <ThreadRow item={item} props={props} showActivity={project.expanded} />} /> : <View style={s.projectEmpty}><Text style={s.projectEmptyText}>暂无聊天</Text></View>}
    </Animated.View>}
  </View>;
}

export function Directory(props: Props) {
  const { view, deviceId, rows, wide } = props;
  return <View style={[s.drawer, wide && s.sidebar, { paddingTop: props.paddingTop, paddingBottom: props.paddingBottom }]}>
    <View style={s.drawerHeader}><Text style={s.brand}>Codexer</Text>{!wide && <Pressable accessibilityRole="button" accessibilityLabel="关闭会话列表" onPress={props.close} style={s.iconButton}><X size={20} color={c.text} /></Pressable>}</View>
    <View style={s.search}><Search size={17} color={c.muted} /><TextInput accessibilityLabel="搜索会话" style={s.searchInput} value={props.search} onChangeText={props.setSearch} placeholder="搜索会话" placeholderTextColor={c.muted} /></View>
    <Text style={s.section}>同账号的 PC Agent</Text>
    <DevicePicker devices={view.devices} deviceId={deviceId} selectDevice={props.selectDevice} />
    <FlatList data={rows} keyExtractor={row => `${row.type}:${row.id}`} style={s.list} contentContainerStyle={s.listContent} renderItem={({item}) => item.type === 'section' ? <Text style={s.drawerSection}>{item.title}</Text> : item.type === 'project' ? <ProjectRow project={item} props={props} /> : <ThreadRow item={item} props={props} />} ListEmptyComponent={<Text style={s.empty}>{view.catalogs[deviceId] ? '没有匹配的会话' : '正在读取项目与会话'}</Text>} />
    <View style={s.drawerFooter}><Text style={s.drawerStatus}>{view.phase === 'connected' ? `${view.devices.length} 台 PC Agent` : '正在重新连接'}</Text><Pressable accessibilityRole="button" accessibilityLabel="刷新设备" onPress={props.refresh} style={s.iconButton}><RefreshCw size={19} color={c.text} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="连接设置" onPress={props.settings} style={s.iconButton}><Settings2 size={19} color={c.text} /></Pressable></View>
  </View>;
}
