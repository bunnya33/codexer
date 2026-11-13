import {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Platform, Pressable, StyleSheet, Text, View} from 'react-native';
import {Bot, ChevronRight, Images, Layers, Pencil} from 'lucide-react-native';
import {collaborationSummary, executionItemActive, imageActivitySummary} from '../../../packages/client-shared/src/activity';
import type {ImageActivitySection} from '../../../packages/client-shared/src/activity';
import type {HistoryTurn, RemoteItem, RemoteSubAgent} from '../../../packages/protocol/src/index';
import {FileChangesPanel} from './file-review';
import {useTheme} from './styles';
import {relay} from './relay';
import {RelayImage} from './relay-image';
import {ShimmerLabel} from './shimmer';
import {Disclosure} from './interaction/disclosure';
import {useInteractionMotion} from './interaction/motion';
import {DrawerSwipeBlock} from './drawer-swipe-block';

export function AgentActivityRecord({item, running, agents = []}: {item: RemoteItem; running: boolean; agents?: RemoteSubAgent[]}) {
  const {c} = useTheme();
  const label = collaborationSummary(item, running, agents);
  const waiting = item.type === 'collabAgentToolCall' && item.tool === 'wait';
  const active = waiting && executionItemActive(item, running);
  const event = item.type === 'subAgentActivity';
  return <View testID={`agent-activity-${item.id}`} style={styles.row}>
    {!waiting && (event ? <View testID="agent-activity-avatar" style={styles.avatar}><Bot size={11} color="#10a37f" /></View> : <Bot size={14} color={c.muted} />)}
    {active ? <ShimmerLabel text={label} /> : <Text selectable style={[styles.label, {color: item.status === 'failed' ? c.danger : c.muted}]}>{label}</Text>}
  </View>;
}

export function CompactionActivityRecord({item}: {item: RemoteItem}) {
  const {c} = useTheme();
  const label = ['running', 'inProgress'].includes(item.status ?? '') ? '正在压缩上下文' : item.status === 'failed' ? '上下文压缩失败' : '已压缩上下文';
  return <View testID={`compaction-activity-${item.id}`} style={styles.row}><Layers size={14} color={c.muted}/><Text style={[styles.label, {color: c.muted}]}>{label}</Text></View>;
}

export function FileActivityRecord({item, running, turn, deviceId, threadId}: {item: RemoteItem; running: boolean; turn: HistoryTurn; deviceId: string; threadId: string}) {
  const {c} = useTheme();
  const operations = item.fileOperations?.length ? item.fileOperations : (item.files ?? []).map(path => ({path, kind: 'unknown' as const}));
  const active = executionItemActive(item, running);
  const prefix = item.status === 'failed' ? '编辑失败' : item.status === 'declined' ? '已拒绝编辑' : ['interrupted', 'cancelled'].includes(item.status ?? '') ? '已停止编辑' : active ? '正在' : '已';
  const row = (operation: NonNullable<RemoteItem['fileOperations']>[number], openFile?: (path: string) => void) => {
    const verb = {add:'创建', update:'编辑', delete:'删除', unknown:'修改'}[operation.kind];
    const label = prefix === '已' || prefix === '正在' ? prefix + verb : prefix;
    const name = operation.path.split(/[\\/]/).at(-1) || operation.path;
    const body = <><Pencil size={14} color={c.muted}/><Text style={[styles.label, {color: c.muted}]}>{label} <Text style={openFile ? {textDecorationLine:'underline'} : undefined}>{name}</Text></Text>{operation.additions !== undefined && <Text style={[styles.label, {color:c.muted}]}>+{operation.additions} -{operation.deletions ?? 0}</Text>}</>;
    return openFile ? <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${operation.path}，查看差异`} onPress={() => openFile(operation.path)} style={styles.row}>{body}</Pressable> : <View style={styles.row}>{body}</View>;
  };
  return <View testID={`file-activity-${item.id}`} style={{gap:2}}>{operations.map(operation => {
    const changes = (turn.fileChanges ?? []).filter(change => change.path === operation.path);
    return changes.length ? <FileChangesPanel key={operation.path} changes={changes} deviceId={deviceId} threadId={threadId} turnId={turn.id} renderTrigger={openFile => row(operation, openFile)}/> : <View key={operation.path}>{row(operation)}</View>;
  })}{!operations.length && <View style={styles.row}><Pencil size={14} color={c.muted}/><Text style={[styles.label, {color:c.muted}]}>{active ? '正在修改文件' : '文件修改记录'}</Text></View>}</View>;
}

export function ImageActivityRecord({section, deviceId, threadId, onImage}: {
  section: ImageActivitySection; deviceId: string; threadId: string;
  onImage: (source: {uri: string; headers?: Record<string, string>}, name: string) => void;
}) {
  const {c} = useTheme();
  const motion = useInteractionMotion();
  const [open, setOpen] = useState(false);
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(rotation, {toValue: open ? 1 : 0, duration: motion ? 240 : 0, easing: Easing.inOut(Easing.cubic), useNativeDriver: Platform.OS !== 'web'});
    animation.start();
    return () => animation.stop();
  }, [open, motion, rotation]);
  const label = imageActivitySummary(section);
  const images = section.items.flatMap(item => (item.images ?? []).map(image => ({...image, key: `${item.id}:${image.id}`})));
  return <View testID={`image-activity-${section.id}`}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}，${open ? '收起' : '展开'}图像`} accessibilityState={{expanded: open}} aria-expanded={open} hitSlop={6} onPress={() => setOpen(value => !value)} style={styles.row}>
      <Images size={14} color={c.muted} />
      <Text style={[styles.label, {color: c.muted}]}>{label}</Text>
      <Animated.View testID="image-activity-arrow" style={{transform: [{rotate: rotation.interpolate({inputRange: [0, 1], outputRange: ['0deg', '90deg']})}]}}><ChevronRight size={13} color={c.muted} /></Animated.View>
    </Pressable>
    <Disclosure open={open}>
      <DrawerSwipeBlock style={styles.images}>{images.map(image => <Pressable key={image.key} accessibilityRole="button" accessibilityLabel={`查看图像 ${image.name}`} onPress={() => onImage(relay.imageSource(deviceId, threadId, image.id), image.name)}>
        <RelayImage source={relay.imageSource(deviceId, threadId, image.id)} style={[styles.image, {backgroundColor: c.code, borderColor: c.line}]} resizeMode="cover" />
      </Pressable>)}</DrawerSwipeBlock>
      {!images.length && <Text style={[styles.label, {color: c.muted, paddingVertical: 6}]}>当前记录未提供图像预览。</Text>}
    </Disclosure>
  </View>;
}

const styles = StyleSheet.create({
  row: {minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: 7},
  label: {fontSize: 12, lineHeight: 18, flexShrink: 1},
  avatar: {width: 15, height: 15, borderRadius: 8, backgroundColor: 'rgba(16,163,127,0.14)', alignItems: 'center', justifyContent: 'center'},
  images: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 5, paddingBottom: 3},
  image: {width: 78, height: 78, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8},
});
