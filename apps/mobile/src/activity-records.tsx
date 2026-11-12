import {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Platform, Pressable, StyleSheet, Text, View} from 'react-native';
import {Bot, ChevronRight, Images} from 'lucide-react-native';
import {collaborationSummary, executionItemActive, imageActivitySummary} from '../../../packages/client-shared/src/activity';
import type {ImageActivitySection} from '../../../packages/client-shared/src/activity';
import type {RemoteItem, RemoteSubAgent} from '../../../packages/protocol/src/index';
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
