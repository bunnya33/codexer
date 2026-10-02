import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, FlatList, Image, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Archive, ArrowDown, ArrowUp, Check, ChevronDown, ImagePlus, Info, ListChecks, LogOut, Menu, Pencil, RefreshCw, Square, Terminal, Trash2, X } from 'lucide-react-native';
import { mergeLiveTurn } from '../../packages/client-shared/src/activity';
import { conversationImages } from '../../packages/client-shared/src/images';
import type { ImageDirection, ImageGallery, ImagePreview } from '../../packages/client-shared/src/images';
import { buildDirectoryRows } from '../../packages/client-shared/src/directory';
import { effortLabel, modelLabel } from '../../packages/client-shared/src/models';
import { MAX_IMAGES, MAX_IMAGE_BYTES } from '../../packages/protocol/src/index';
import type { HistoryTurn, RemoteCommand } from '../../packages/protocol/src/index';
import { FileChangesPanel, RequestPanel, TurnView } from './src/conversation';
import { ImageViewer } from './src/image-viewer';
import { historyKey, relay } from './src/relay';
import { c, s } from './src/styles';
import { Directory } from './src/directory';
import { confirmAction, defaultRelayUrl } from './src/runtime';
import { ComposerInput } from './src/composer';
import { ConversationViewport } from './src/conversation-viewport';

type DraftImage = { key: number; uri: string; name: string; asset?: ImagePicker.ImagePickerAsset; id?: string; loading: boolean; error?: string };
type Icon = typeof Menu;

function IconButton({ icon: IconView, label, onPress, disabled = false }: { icon: Icon; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled} style={({ pressed }) => [s.iconButton, pressed && s.pressed, disabled && s.disabled]}><IconView size={20} color={c.text} strokeWidth={1.8} /></Pressable>;
}

function Login({ connect, busy, error }: { connect: (url: string, username: string, password: string) => void; busy: boolean; error: string }) {
  const [url, setUrl] = useState(defaultRelayUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const relayUrl = Platform.OS === 'web' ? defaultRelayUrl() : url;
  return <SafeAreaView style={s.safe}><StatusBar style="dark" /><View style={s.login}>
    <View style={s.brandRow}><View style={s.brandMark}><Terminal size={24} color="#fff" /></View><Text style={s.brand}>Codexer</Text></View>
    <Text style={s.heading}>账号登录</Text><Text style={s.sub}>登录后选择同账号的 PC Agent</Text>
    {Platform.OS !== 'web' && <><Text style={s.label}>服务器地址</Text><TextInput accessibilityLabel="服务器地址" style={s.field} value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://服务器地址:端口" placeholderTextColor={c.muted} /></>}
    <Text style={s.label}>账号</Text><TextInput accessibilityLabel="账号" style={s.field} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" placeholder="账号名称" placeholderTextColor={c.muted} />
    <Text style={s.label}>密码</Text><TextInput accessibilityLabel="密码" style={s.field} value={password} onChangeText={setPassword} autoCapitalize="none" autoCorrect={false} autoComplete="current-password" secureTextEntry placeholder="密码" placeholderTextColor={c.muted} />
    {!!error && <Text style={s.error}>{error}</Text>}
    <Pressable accessibilityRole="button" onPress={() => connect(relayUrl, username, password)} disabled={busy || !relayUrl.trim() || !username.trim() || !password} style={[s.primary, (busy || !relayUrl.trim() || !username.trim() || !password) && s.disabled]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>登录</Text>}</Pressable>
  </View></SafeAreaView>;
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = Platform.OS === 'web' && width >= 900;
  const view = useSyncExternalStore(relay.subscribe, relay.getSnapshot);
  const [restoring, setRestoring] = useState(true);
  const [loginBusy, setLoginBusy] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [threadId, setThreadId] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<DraftImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<'none' | 'settings' | 'model' | 'effort' | 'mode'>('none');
  const [actionThread, setActionThread] = useState<{ id: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [managing, setManaging] = useState(false);
  const [preview, setPreview] = useState<ImageGallery | null>(null);
  const listRef = useRef<FlatList<HistoryTurn>>(null);
  const streamKey = historyKey(deviceId, threadId);
  const currentStreamKey = useRef(streamKey);
  currentStreamKey.current = streamKey;
  const atBottom = useRef(true);
  const seekingBottom = useRef(true);
  const manualScroll = useRef(false);
  const scrollMetrics = useRef({height: 0, offset: 0});
  const olderAnchor = useRef<{height: number; offset: number} | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const scrollFrame = useRef<number | null>(null);
  const scrollToBottom = useCallback(() => {
    atBottom.current = true;
    seekingBottom.current = true;
    manualScroll.current = false;
    setShowJumpToBottom(false);
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (manualScroll.current || !atBottom.current) return;
      // ScrollView includes the footer and content padding in the true end position.
      const responder = listRef.current?.getScrollResponder() as unknown as ScrollView | null;
      responder?.scrollToEnd({ animated: false });
    });
  }, []);
  const nextImageKey = useRef(0);
  const moveImage = useCallback((direction: ImageDirection) => setPreview(current => {
    if (!current) return null;
    const index = current.index + direction;
    return index >= 0 && index < current.images.length ? { ...current, index } : current;
  }), []);
  const edgeSwipe = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => gesture.x0 <= 28 && gesture.dx > 16 && gesture.dx > Math.abs(gesture.dy) * 1.5,
    onPanResponderRelease: (_, gesture) => { if (gesture.dx > 65 && Math.abs(gesture.dy) < gesture.dx) setDrawerOpen(true); },
  })).current;

  useEffect(() => { void relay.restore().finally(() => setRestoring(false)); return () => relay.disconnect(); }, []);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const visible = () => relay.setForeground(document.visibilityState === 'visible');
      const leaving = () => relay.setForeground(false);
      visible();
      document.addEventListener('visibilitychange', visible);
      window.addEventListener('pageshow', visible);
      window.addEventListener('pagehide', leaving);
      return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('pageshow', visible); window.removeEventListener('pagehide', leaving); };
    }
    relay.setForeground(AppState.currentState === 'active');
    const listener = AppState.addEventListener('change', state => relay.setForeground(state === 'active'));
    return () => listener.remove();
  }, []);
  useEffect(() => { if (view.phase === 'locked') { setThreadId(''); setDeviceId(''); setDraft(''); setImages([]); setDrawerOpen(false); setActionThread(null); setPreview(null); setMenu('none'); } }, [view.phase]);
  useEffect(() => { if (!view.devices.some(device => device.id === deviceId)) setDeviceId(view.devices[0]?.id ?? ''); }, [view.devices, deviceId]);
  useEffect(() => { if (view.phase === 'connected' && deviceId && !view.catalogs[deviceId]) void relay.loadCatalog(deviceId); }, [deviceId, view.catalogs, view.phase]);
  useEffect(() => {
    const entries = view.catalogs[deviceId]?.threads.filter(item => !item.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    if (entries?.length && !threadId) setThreadId(entries[0]!.id);
  }, [deviceId, threadId, view.catalogs]);
  useEffect(() => {
    setPreview(null);
    olderAnchor.current = null;
    scrollMetrics.current = {height: 0, offset: 0};
    scrollToBottom();
    if (deviceId && threadId) void relay.loadHistory(deviceId, threadId);
    return () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); };
  }, [deviceId, threadId, scrollToBottom]);

  const device = view.devices.find(item => item.id === deviceId);
  const catalog = view.catalogs[deviceId];
  const snapshot = view.snapshots[deviceId];
  const thread = snapshot?.threads[threadId];
  const questionRequestIds = useMemo(() => thread?.requests.filter(request => request.details.source === 'asyncMessage').map(request => request.id) ?? [], [thread?.requests]);
  const summary = catalog?.threads.find(item => item.id === threadId);
  const project = catalog?.projects.find(item => item.id === summary?.projectId);
  const history = view.histories[historyKey(deviceId, threadId)];
  useEffect(() => { if (view.phase === 'connected' && deviceId && threadId && device?.online && !view.syncing[deviceId]) { relay.watchThread(deviceId, threadId); if (!history || history.error) void relay.loadHistory(deviceId, threadId); } }, [view.phase, deviceId, threadId, device?.online, view.syncing[deviceId], snapshot?.epoch, thread?.ownerAvailable]);
  useEffect(() => { if (view.phase !== 'connected' || !deviceId || !threadId || !device?.online || view.syncing[deviceId] || thread?.ownerAvailable) return; const timer = setInterval(() => relay.watchThread(deviceId, threadId), 16000); return () => clearInterval(timer); }, [view.phase, deviceId, threadId, device?.online, view.syncing[deviceId], thread?.ownerAvailable]);
  const ready = view.phase === 'connected' && !!device?.online && !view.syncing[deviceId] && !!thread?.ownerAvailable && ['idle', 'active'].includes(thread.status);
  const turns = useMemo(() => {
    const result = [...(history?.turns ?? [])];
    for (const live of thread?.turns ?? []) { const index = result.findIndex(item => item.id === live.id); if (index < 0) result.push(live); else result[index] = mergeLiveTurn(result[index]!, live); }
    return result;
  }, [history?.turns, thread?.turns]);
  const galleryContext = useRef({ turns, deviceId, threadId });
  galleryContext.current = { turns, deviceId, threadId };
  const openImage = useCallback((source: ImagePreview['source'], name: string) => {
    const context = galleryContext.current;
    const entries: ImagePreview[] = conversationImages(context.turns).map(image => ({ source: relay.imageSource(context.deviceId, context.threadId, image.id), name: image.name }));
    let index = entries.findIndex(image => image.source.uri === source.uri);
    if (index < 0) { index = entries.length; entries.push({ source, name }); }
    setPreview({ images: entries, index });
  }, []);
  const changedTurn = thread?.status === 'active' ? turns.find(turn => turn.id === thread.activeTurnId && !!turn.fileChanges?.length) : undefined;
  const hasTruncatedContent = turns.some(turn => turn.truncated || turn.items.some(item => item.truncated));
  const rows = useMemo(() => buildDirectoryRows({catalog, snapshot, deviceId, expandedProjects, search}), [catalog, deviceId, expandedProjects, search, snapshot]);

  const connect = async (url: string, username: string, password: string) => { setLoginBusy(true); try { await relay.connect(url, username, password, true); } catch { /* Error appears in the login view. */ } finally { setLoginBusy(false); } };
  const selectThread = (id: string) => { setThreadId(id); setDraft(''); setImages([]); setDrawerOpen(false); };
  const createThread = async (projectId: string) => {
    if (managing) return;
    setManaging(true);
    try {
      const result = await relay.sendCommand(deviceId, { type: 'thread.create', projectId });
      if (result.status !== 'succeeded' || typeof result.result?.threadId !== 'string') throw new Error(result.code);
      await relay.loadCatalog(deviceId);
      selectThread(result.result.threadId);
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : String(error)); }
    finally { setManaging(false); }
  };
  const manageThread = async (payload: Extract<RemoteCommand['payload'], { type: 'thread.rename' | 'thread.archive' | 'thread.delete' }>) => {
    if (managing) return;
    setManaging(true);
    try {
      const result = await relay.sendCommand(deviceId, payload);
      if (result.status !== 'succeeded') throw new Error(result.code);
      setActionThread(null); setRenaming(false);
      await relay.loadCatalog(deviceId);
      if (payload.type !== 'thread.rename' && threadId === payload.threadId) setThreadId('');
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : String(error)); }
    finally { setManaging(false); }
  };
  const send = async (payload: RemoteCommand['payload'], clearDraft = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await relay.sendCommand(deviceId, payload);
      if (result.status !== 'succeeded') throw new Error(result.code);
      if (clearDraft) { setDraft(''); setImages([]); }
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const uploadDraft = async (image: DraftImage, targetDeviceId: string, targetThreadId: string) => {
    const asset = image.asset;
    if (!asset) return;
    setImages(current => current.map(item => item.key === image.key ? { ...item, loading: true, error: undefined } : item));
    try {
      const supported = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mimeType ?? '');
      let base64 = asset.base64?.replace(/\s/g, '');
      let mimeType = asset.mimeType ?? '';
      let name = image.name;
      // Keep the JSON request under the common 1 MB reverse-proxy limit.
      const uploadLimit = Math.min(MAX_IMAGE_BYTES, 700 * 1024);
      if (!supported || !base64 || Math.ceil(base64.length * 3 / 4) > uploadLimit) {
        for (const [edge, quality] of [[1600, 0.65], [1200, 0.5], [900, 0.4]] as const) {
          const scale = Math.min(1, edge / Math.max(asset.width, asset.height));
          const actions = scale < 1 ? [{ resize: { width: Math.max(1, Math.round(asset.width * scale)) } }] : [];
          const converted = await ImageManipulator.manipulateAsync(asset.uri, actions, { format: ImageManipulator.SaveFormat.JPEG, compress: quality, base64: true });
          base64 = converted.base64?.replace(/\s/g, '');
          if (base64 && Math.ceil(base64.length * 3 / 4) <= uploadLimit) break;
        }
        mimeType = 'image/jpeg';
        name = `${name.replace(/\.[^.]+$/, '')}.jpg`;
      }
      if (!base64) throw new Error('无法读取图片');
      if (Math.ceil(base64.length * 3 / 4) > uploadLimit) throw new Error('图片压缩后仍过大');
      const uploaded = await relay.uploadImage(targetDeviceId, targetThreadId, { name, mimeType, base64 });
      setImages(current => current.map(item => item.key === image.key ? { key: item.key, uri: item.uri, name, id: uploaded.id, loading: false } : item));
    } catch (error) {
      const code = error instanceof Error ? error.message : '上传失败';
      setImages(current => current.map(item => item.key === image.key ? { ...item, loading: false, error: code === 'request-too-large' ? '图片请求过大' : code === 'invalid-image' ? '图片格式无效' : code } : item));
    }
  };
  const addImages = (assets: ImagePicker.ImagePickerAsset[]) => {
    for (const asset of assets.slice(0, MAX_IMAGES - images.length)) {
      const image: DraftImage = { key: ++nextImageKey.current, uri: asset.uri, name: (asset.fileName ?? 'image').slice(0, 255), asset, loading: true };
      setImages(current => [...current, image]);
      void uploadDraft(image, deviceId, threadId);
    }
  };
  const pickImages = async () => {
    if (images.length >= MAX_IMAGES) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: MAX_IMAGES - images.length, base64: true, quality: 0.85 });
      if (!result.canceled) addImages(result.assets);
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : '无法读取图片'); }
  };
  const submit = () => {
    if (!thread || busy || !ready || images.some(image => image.loading || image.error)) return;
    const text = draft.trim(), ids = images.map(image => image.id).filter((id): id is string => !!id);
    if (!text && !ids.length) { if (thread.status === 'active' && thread.activeTurnId) void send({ type: 'turn.interrupt', threadId, turnId: thread.activeTurnId }); return; }
    void send({ type: thread.status === 'active' ? 'turn.queue' : 'turn.start', threadId, text, ...(ids.length ? { images: ids } : {}) }, true);
  };
  const changeModel = (model: string) => { setMenu('none'); if (thread?.settings?.model && thread.status === 'idle' && model !== thread.settings.model) void send({ type: 'thread.model.update', threadId, model, expectedModel: thread.settings.model }); };
  const changeEffort = (effort: string) => { setMenu('none'); if (thread?.settings?.model && thread.status === 'idle' && effort !== thread.settings.reasoningEffort) void send({ type: 'thread.effort.update', threadId, effort: effort as Extract<RemoteCommand['payload'], { type: 'thread.effort.update' }>['effort'], expectedModel: thread.settings.model, expectedEffort: thread.settings.reasoningEffort }); };
  const changeMode = (mode: 'default' | 'plan') => {
    setMenu('none');
    if (thread?.settings?.model && thread.status === 'idle' && snapshot?.runtime.capabilities.collaborationModeUpdate && mode !== thread.settings.collaborationMode) void send({ type: 'thread.mode.update', threadId, mode, expectedMode: thread.settings.collaborationMode ?? null, expectedModel: thread.settings.model, expectedEffort: thread.settings.reasoningEffort });
  };
  const loadEarlier = () => {
    atBottom.current = false; seekingBottom.current = false;
    if (Platform.OS === 'web') olderAnchor.current = {...scrollMetrics.current};
    void relay.loadHistory(deviceId, threadId, true);
  };

  const directory = <Directory view={view} deviceId={deviceId} threadId={threadId} rows={rows} search={search} wide={wide} managing={managing} paddingTop={wide ? 0 : insets.top} paddingBottom={wide ? 0 : insets.bottom} setSearch={setSearch}
    selectDevice={id => { setDeviceId(id); setThreadId(''); setDraft(''); setImages([]); }} selectThread={selectThread}
    toggleProject={id => setExpandedProjects(current => current.includes(`${deviceId}:${id}`) ? current.filter(value => value !== `${deviceId}:${id}`) : [...current, `${deviceId}:${id}`])}
    createThread={id => void createThread(id)} threadActions={item => { setDrawerOpen(false); setNewName(item.title); setActionThread({ id: item.id, title: item.title }); }}
    close={() => setDrawerOpen(false)} settings={() => { setDrawerOpen(false); setMenu('settings'); }} refresh={() => void relay.refreshDevices()} />;

  if (restoring) return <SafeAreaView style={[s.safe, s.center]}><ActivityIndicator color={c.accent} /></SafeAreaView>;
  if (view.phase === 'locked') return <Login connect={connect} busy={loginBusy} error={view.notice} />;
  const stopMode = thread?.status === 'active' && !draft.trim() && !images.length;
  const settings = thread?.settings ?? summary?.settings;
  const model = catalog?.models?.find(option => option.model === settings?.model);
  return <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']} {...edgeSwipe.panHandlers}><StatusBar style="dark" />
    <View style={s.appLayout}>
    {wide && directory}
    {
    <KeyboardAvoidingView style={s.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.threadHeader}>{!wide && <IconButton icon={Menu} label="打开会话列表" onPress={() => setDrawerOpen(true)} />}<View style={s.threadHeading}><Text testID="conversation-title" style={s.threadTitle} numberOfLines={1}>{summary?.title ?? thread?.title ?? 'Codexer'}</Text><Text style={s.sub} numberOfLines={1}>{project?.name ?? device?.name ?? '选择设备'}{threadId ? ` · ${thread?.status === 'active' ? '进行中' : thread?.status === 'idle' ? '空闲' : '接入中'}` : ''}</Text></View><>{hasTruncatedContent && <IconButton icon={Info} label="查看会话展示范围" onPress={() => relay.showNotice("部分长记录受传输大小限制。完整内容可在本机 Codex 查看；更早消息可在会话顶部加载。")} />}</><IconButton icon={RefreshCw} label="刷新会话" disabled={!threadId} onPress={() => { void relay.loadHistory(deviceId, threadId); relay.watchThread(deviceId, threadId); }} /></View>
      <ConversationViewport onScrollIntent={() => { manualScroll.current = true; }}><FlatList key={historyKey(deviceId, threadId)} ref={listRef} testID="conversation-stream" data={turns} keyExtractor={item => item.id} style={s.stream} contentContainerStyle={[s.streamContent, wide && s.desktopContent]} initialNumToRender={8} windowSize={7} maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onScroll={event => {
          if (currentStreamKey.current !== streamKey) return;
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          scrollMetrics.current = {height: contentSize.height, offset: contentOffset.y};
          const nearBottom = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
          if ((seekingBottom.current || atBottom.current) && !nearBottom && !manualScroll.current) return;
          seekingBottom.current = false;
          atBottom.current = nearBottom;
          if (nearBottom) manualScroll.current = false;
          setShowJumpToBottom(!nearBottom);
        }} scrollEventThrottle={32}
        onScrollBeginDrag={() => { manualScroll.current = true; }}
        onLayout={() => { if (currentStreamKey.current === streamKey && atBottom.current && !manualScroll.current) scrollToBottom(); }}
        onContentSizeChange={(_width, height) => {
          if (currentStreamKey.current !== streamKey) return;
          if (olderAnchor.current && !history?.loading) {
            const anchor = olderAnchor.current; olderAnchor.current = null;
            listRef.current?.scrollToOffset({offset: Math.max(0, anchor.offset + height - anchor.height), animated: false});
          } else if (atBottom.current && !manualScroll.current) scrollToBottom();
          scrollMetrics.current.height = height;
        }} refreshing={!!history?.nextCursor && !!history.loading}
        onRefresh={Platform.OS !== 'web' && history?.nextCursor ? loadEarlier : undefined}
        renderItem={({ item }) => <TurnView turn={item} active={item.id === thread?.activeTurnId && thread?.status === 'active'} deviceId={deviceId} threadId={threadId} onImage={openImage} questionRequestIds={questionRequestIds} />}
        ListHeaderComponent={history?.nextCursor ? <Pressable accessibilityRole="button" accessibilityLabel="加载更早消息" disabled={history.loading} onPress={loadEarlier} style={s.earlier}>{history.loading ? <ActivityIndicator size="small" color={c.accent} /> : <Text style={s.earlierText}>{Platform.OS === 'web' ? '加载更早消息' : '下拉加载更早消息'}</Text>}</Pressable> : null}
        ListEmptyComponent={<View style={s.chatEmpty}><Terminal size={30} color={c.accent} /><Text style={s.chatEmptyTitle}>{threadId ? history?.loading ? '正在读取会话' : '开始对话' : view.devices.length ? '选择 PC Agent 和会话' : '等待 PC Agent 登录'}</Text><Text style={s.chatEmptySub}>{threadId ? '消息将在这里显示' : view.devices.length ? '从左侧选择要控制的 PC Agent' : '在 PC 上使用同一账号登录，即可在这里选择控制端'}</Text></View>}
        ListFooterComponent={<View>{!!history?.error && <Text style={s.error}>{history.error}</Text>}{thread?.requests.map(request => <RequestPanel key={request.id} request={request} threadId={threadId} enabled={ready && !busy} send={async payload => { const result = await relay.sendCommand(deviceId, payload); if (result.status !== 'succeeded') throw new Error(result.code); }} />)}</View>} /></ConversationViewport>
      {!!thread?.queuedMessages?.length && <View style={s.queue}>{thread.queuedMessages.map(item => <View key={item.id} style={s.queueRow}><Text numberOfLines={1} style={s.queueText}>{item.text || `${item.imageCount} 张图片`}</Text><Text style={s.queueStatus}>{item.status === 'queued' ? '待发送' : item.status === 'sending' ? '发送中' : '未确认'}</Text>{item.status === 'queued' && thread.activeTurnId && <Pressable accessibilityRole="button" onPress={() => void send({ type: 'turn.queue.steer', threadId, turnId: thread.activeTurnId!, queueId: item.id })}><Text style={s.queueAction}>引导</Text></Pressable>}{item.status !== 'sending' && <IconButton icon={X} label="移除待发送消息" onPress={() => void send({ type: 'turn.queue.remove', threadId, queueId: item.id })} />}</View>)}</View>}
      <View testID="composer-dock" style={[s.composerDock, wide && {maxWidth: 900, alignSelf: 'center'}]}>
        {showJumpToBottom && <Pressable accessibilityRole="button" accessibilityLabel="滚动到会话底部" style={s.jumpToBottom} onPress={scrollToBottom}><ArrowDown size={19} color={c.text} /></Pressable>}
        {!!changedTurn?.fileChanges?.length && <FileChangesPanel key={`${deviceId}:${threadId}:${changedTurn.id}`} changes={changedTurn.fileChanges} />}
      <View style={[s.composer, wide && { width: '94%', maxWidth: 864, alignSelf: 'center', marginBottom: 20 }]}>{!!view.notice && <Text style={s.notice} numberOfLines={2}>{view.notice}</Text>}{!ready && <Text style={s.hint}>{!threadId ? '请选择会话' : view.phase === 'reconnecting' ? '正在重连服务器' : view.phase === 'connecting' ? '正在连接服务器' : !device?.online ? '设备离线' : view.syncing[deviceId] ? '同步中' : '正在接入会话'}</Text>}{!!images.length && <ScrollView horizontal style={s.draftStrip}>{images.map(image => <View key={image.key} style={s.draftImage}><Image source={{ uri: image.uri }} style={s.thumbnail} />{image.loading ? <ActivityIndicator size="small" /> : image.error ? <Pressable accessibilityRole="button" accessibilityLabel={`重试上传 ${image.name}`} disabled={!ready} onPress={() => void uploadDraft(image, deviceId, threadId)}><Text style={s.error}>{image.error} · 重试</Text></Pressable> : <Check size={14} color={c.accent} />}<Pressable accessibilityRole="button" accessibilityLabel={`移除 ${image.name}`} onPress={() => setImages(current => current.filter(item => item.key !== image.key))}><X size={17} color={c.muted} /></Pressable></View>)}</ScrollView>}
        <ComposerInput accessibilityLabel="给 Codex 发送消息" style={s.composerInput} value={draft} onChangeText={setDraft} multiline maxLength={32000} editable={!!ready && !busy} placeholder="给 Codex 发送消息" placeholderTextColor={c.muted} textAlignVertical="top" onImages={addImages} imagesEnabled={ready && !busy && !!snapshot?.runtime.capabilities.images && images.length < MAX_IMAGES} onImageError={message => relay.showNotice(message)} onKeyPress={event => { const key = event.nativeEvent as { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }; if (Platform.OS === 'web' && key.key === 'Enter' && !key.shiftKey && !key.isComposing && key.keyCode !== 229) { event.preventDefault(); submit(); } }} />
        <View style={s.toolbar}><IconButton icon={ImagePlus} label="添加图片" disabled={!ready || busy || !snapshot?.runtime.capabilities.images || images.length >= MAX_IMAGES} onPress={() => void pickImages()} /><Pressable style={s.pill} disabled={!ready || busy || thread?.status !== 'idle'} onPress={() => setMenu('model')}><Text numberOfLines={1} style={s.pillText}>{modelLabel(settings?.model, catalog?.models)}</Text><ChevronDown size={14} color={c.muted} /></Pressable><Pressable style={s.pill} disabled={!ready || busy || thread?.status !== 'idle' || !model?.supportedReasoningEfforts.length} onPress={() => setMenu('effort')}><Text style={s.pillText}>{effortLabel(settings?.reasoningEffort)}</Text><ChevronDown size={14} color={c.muted} /></Pressable>{!!snapshot?.runtime.capabilities.collaborationModeUpdate && <Pressable accessibilityRole="button" accessibilityLabel={`工作模式：${settings?.collaborationMode === 'plan' ? 'Plan' : '默认'}`} style={[s.pill, s.modePill, settings?.collaborationMode === 'plan' && s.modeActive]} disabled={!ready || busy || thread?.status !== 'idle'} onPress={() => setMenu('mode')}><ListChecks size={15} color={settings?.collaborationMode === 'plan' ? c.accent : c.muted} /><Text style={s.pillText}>{settings?.collaborationMode === 'plan' ? 'Plan' : '默认'}</Text></Pressable>}<View style={s.spacer} /><Pressable accessibilityRole="button" accessibilityLabel={stopMode ? '停止当前任务' : thread?.status === 'active' ? '添加到待发送' : '发送消息'} disabled={!ready || busy || images.some(image => image.loading || !!image.error)} onPress={submit} style={[s.send, stopMode && s.stop, (!ready || busy) && s.disabled]}>{busy ? <ActivityIndicator color="#fff" size="small" /> : stopMode ? <Square size={18} color="#fff" fill="#fff" /> : <ArrowUp size={20} color="#fff" />}</Pressable></View>
      </View>
      </View>
    </KeyboardAvoidingView>}
    </View>
    <Modal visible={drawerOpen && !wide} transparent animationType="fade" onRequestClose={() => setDrawerOpen(false)}>
      <View style={s.drawerOverlay}>
        {directory}
        <Pressable accessibilityRole="button" accessibilityLabel="关闭会话列表" style={s.drawerScrim} onPress={() => setDrawerOpen(false)} />
      </View>
    </Modal>
    <Modal visible={!!actionThread} transparent animationType="fade" onRequestClose={() => { setActionThread(null); setRenaming(false); }}>
      <Pressable style={s.backdrop} onPress={() => { setActionThread(null); setRenaming(false); }}>
        <Pressable style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]} onPress={event => event.stopPropagation()}>
          <View style={s.modalHeader}><Text style={s.modalTitle} numberOfLines={1}>{renaming ? '重命名会话' : actionThread?.title}</Text><IconButton icon={X} label="关闭" onPress={() => { setActionThread(null); setRenaming(false); }} /></View>
          {renaming ? <><TextInput style={s.field} value={newName} onChangeText={setNewName} autoFocus maxLength={1000} /><Pressable style={[s.primary, (!newName.trim() || managing) && s.disabled]} disabled={!newName.trim() || managing} onPress={() => actionThread && void manageThread({ type: 'thread.rename', threadId: actionThread.id, name: newName.trim() })}><Text style={s.primaryText}>保存</Text></Pressable></> : <>
            <Pressable style={s.menuOption} disabled={managing} onPress={() => setRenaming(true)}><Pencil size={18} color={c.text} /><Text style={s.menuText}>重命名</Text></Pressable>
            <Pressable style={s.menuOption} disabled={managing} onPress={() => actionThread && void manageThread({ type: 'thread.archive', threadId: actionThread.id })}><Archive size={18} color={c.text} /><Text style={s.menuText}>归档</Text></Pressable>
            <Pressable style={s.menuOption} disabled={managing} onPress={() => { const target = actionThread; if (target) void confirmAction('永久删除会话', `删除“${target.title}”后无法恢复。`).then(confirmed => { if (confirmed) void manageThread({ type: 'thread.delete', threadId: target.id }); }); }}><Trash2 size={18} color={c.danger} /><Text style={s.dangerText}>永久删除</Text></Pressable>
          </>}
        </Pressable>
      </Pressable>
    </Modal>
    <Modal visible={menu !== 'none'} transparent animationType="fade" onRequestClose={() => setMenu('none')}><Pressable style={s.backdrop} onPress={() => setMenu('none')}><Pressable style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]} onPress={event => event.stopPropagation()}><View style={s.modalHeader}><Text style={s.modalTitle}>{menu === 'settings' ? '连接' : menu === 'model' ? '选择模型' : menu === 'mode' ? '工作模式' : '推理强度'}</Text><IconButton icon={X} label="关闭" onPress={() => setMenu('none')} /></View>{menu === 'settings' ? <><Text style={s.sub}>{view.url}</Text><Pressable style={s.menuOption} onPress={() => { setMenu('none'); void relay.logout().catch(() => undefined); }}><LogOut size={18} color={c.danger} /><Text style={s.dangerText}>退出登录</Text></Pressable></> : menu === 'mode' ? <View><Pressable style={s.menuOption} onPress={() => changeMode('default')}><View style={{flex: 1}}><Text style={s.menuText}>默认模式</Text><Text style={s.sub}>按请求执行任务</Text></View>{settings?.collaborationMode === 'default' && <Check size={18} color={c.accent} />}</Pressable><Pressable style={s.menuOption} onPress={() => changeMode('plan')}><View style={{flex: 1}}><Text style={s.menuText}>Plan Mode</Text><Text style={s.sub}>先讨论和形成计划，再切换默认模式执行</Text></View>{settings?.collaborationMode === 'plan' && <Check size={18} color={c.accent} />}</Pressable></View> : menu === 'model' ? <ScrollView style={s.optionList}>{[...new Set([settings?.model, ...(catalog?.models?.map(option => option.model) ?? [])].filter((value): value is string => !!value))].map(name => <Pressable key={name} style={s.menuOption} onPress={() => changeModel(name)}><Text style={s.menuText}>{modelLabel(name, catalog?.models)}</Text>{settings?.model === name && <Check size={18} color={c.accent} />}</Pressable>)}</ScrollView> : <ScrollView style={s.optionList}>{model?.supportedReasoningEfforts.map(effort => <Pressable key={effort} style={s.menuOption} onPress={() => changeEffort(effort)}><Text style={s.menuText}>{effortLabel(effort)}</Text>{settings?.reasoningEffort === effort && <Check size={18} color={c.accent} />}</Pressable>)}</ScrollView>}</Pressable></Pressable></Modal>
    <ImageViewer preview={preview} onClose={() => setPreview(null)} onNavigate={moveImage} />
  </SafeAreaView>;
}

export default function App() { return <SafeAreaProvider><AppContent /></SafeAreaProvider>; }
