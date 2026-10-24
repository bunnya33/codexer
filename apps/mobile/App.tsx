import { ThemeProvider } from './src/theme';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Archive, ArrowDown, ArrowUp, Check, ListChecks, Paperclip, Pencil, Square, Terminal, Trash2, X } from 'lucide-react-native';
import { mergeTurnHistory } from '../../packages/client-shared/src/activity';
import { conversationImages } from '../../packages/client-shared/src/images';
import type { ImageDirection, ImageGallery, ImagePreview } from '../../packages/client-shared/src/images';
import { buildDirectoryRows } from '../../packages/client-shared/src/directory';
import { MAX_IMAGES, MAX_IMAGE_BYTES } from '../../packages/protocol/src/index';
import type { HistoryTurn, RemoteCommand } from '../../packages/protocol/src/index';
import { FileChangesPanel, RequestPanel, TurnView } from './src/conversation';
import { FileViewerProvider } from './src/file-viewer';
import { PreviewContext } from './src/preview-context';
import { ConversationHeader } from './src/conversation-header';
import { ConversationId } from './src/conversation-id';
import { conversationSubAgents } from '../../packages/client-shared/src/sub-agents';
import { ImageViewer } from './src/image-viewer';
import { historyKey, relay } from './src/relay';
import { useTheme } from './src/styles';
import { Directory } from './src/directory';
import { ProjectCreate } from './src/project-create';
import { confirmAction, defaultRelayUrl } from './src/runtime';
import { ComposerInput } from './src/composer';
import { ConversationViewport } from './src/conversation-viewport';
import { ConversationDrawer } from './src/conversation-drawer';
import { DrawerSwipeArea } from './src/drawer-swipe-area';
import { DrawerSwipeBlock } from './src/drawer-swipe-block';
import { ConversationScroll } from '../../packages/client-shared/src/conversation-scroll';
import type { ScrollDirection } from '../../packages/client-shared/src/conversation-scroll';
import { useConversationSelection } from './src/conversation-selection';
import { WeixinSettings } from './src/weixin-settings';
import { ModelEffortPicker } from './src/model-effort-picker';
import { QueuedMessages } from './src/queued-messages';
import { QueueEditor } from './src/queue-editor';
import { Dialog } from './src/dialog';
import { ControlSettings } from './src/control-settings';
import {SettingsShell} from './src/settings-shell';
import {useClientUpdates} from './src/client-updates';
import { AttachmentMenu } from './src/attachment-menu';
import { PermissionPicker, permissionLabels } from './src/permission-picker';
import { pickAttachments } from './src/attachment-picker';
import type { AttachmentAsset } from './src/attachment-picker';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../../packages/protocol/src/uploads';

type DraftImage = { key: number; uri: string; name: string; asset?: ImagePicker.ImagePickerAsset; id?: string; loading: boolean; error?: string };
type DraftAttachment = { key: number; asset: AttachmentAsset; id?: string; loading: boolean; error?: string };
function Login({ connect, busy, error }: { connect: (url: string, username: string, password: string) => void; busy: boolean; error: string }) {
  const { c, s, theme } = useTheme();
  const [url, setUrl] = useState(defaultRelayUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const relayUrl = Platform.OS === 'web' ? defaultRelayUrl() : url;
  return <SafeAreaView style={s.safe}><StatusBar style={theme.dark ? "light" : "dark"} /><View style={s.login}>
    <View style={s.brandRow}><View style={s.brandMark}><Terminal size={24} color={c.onSolid} /></View><Text style={s.brand}>Codexer</Text></View>
    <Text style={s.heading}>账号登录</Text><Text style={s.sub}>登录后选择同账号的 PC Agent</Text>
    {Platform.OS !== 'web' && <><Text style={s.label}>服务器地址</Text><TextInput accessibilityLabel="服务器地址" style={s.field} value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://服务器地址:端口" placeholderTextColor={c.muted} /></>}
    <Text style={s.label}>账号</Text><TextInput accessibilityLabel="账号" style={s.field} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" placeholder="账号名称" placeholderTextColor={c.muted} />
    <Text style={s.label}>密码</Text><TextInput accessibilityLabel="密码" style={s.field} value={password} onChangeText={setPassword} autoCapitalize="none" autoCorrect={false} autoComplete="current-password" secureTextEntry placeholder="密码" placeholderTextColor={c.muted} />
    {!!error && <Text style={s.error}>{error}</Text>}
    <Pressable accessibilityRole="button" onPress={() => connect(relayUrl, username, password)} disabled={busy || !relayUrl.trim() || !username.trim() || !password} style={[s.primary, (busy || !relayUrl.trim() || !username.trim() || !password) && s.disabled]}>{busy ? <ActivityIndicator color={c.onAccent} /> : <Text style={s.primaryText}>登录</Text>}</Pressable>
  </View></SafeAreaView>;
}

function AppContent() {
  const { c, s, theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = ['web', 'windows', 'macos'].includes(Platform.OS) && width >= 900;
  const view = useSyncExternalStore(relay.subscribe, relay.getSnapshot);
  const clientUpdates=useClientUpdates();
  const [restoring, setRestoring] = useState(true);
  const [loginBusy, setLoginBusy] = useState(false);
  const { deviceId, threadId, selectDevice: setDeviceId, selectThread: setThreadId } = useConversationSelection(view);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<DraftImage[]>([]);
  const [files, setFiles] = useState<DraftAttachment[]>([]);
  const fileUploads = useRef(new Map<number, AbortController>());
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<'settings' | 'mode' | 'weixin' | 'permissions'>('settings');
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = (kind: typeof menu) => { setMenu(kind); setMenuOpen(true); };
  // Keep the selected content mounted while Modal plays its closing animation.
  const closeMenu = () => setMenuOpen(false);
  const [actionThread, setActionThread] = useState<{ id: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [managing, setManaging] = useState(false);
  const [projectDeviceId, setProjectDeviceId] = useState('');
  const [preview, setPreview] = useState<ImageGallery | null>(null);
  const listRef = useRef<FlatList<HistoryTurn>>(null);
  const streamKey = historyKey(deviceId, threadId);
  const currentStreamKey = useRef(streamKey);
  currentStreamKey.current = streamKey;
  const scrollPosition = useRef(new ConversationScroll());
  const olderAnchor = useRef<{height: number; offset: number} | null>(null);
  const earlierRequest = useRef<{key: string; cursor: string} | null>(null);
  const loadEarlierRef = useRef<() => void>(() => {});
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const scrollFrame = useRef<number | null>(null);
  const scrollToBottom = useCallback(() => {
    scrollPosition.current.requestBottom();
    setShowJumpToBottom(false);
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (!scrollPosition.current.shouldFollow) return;
      // ScrollView includes the footer and content padding in the true end position.
      const responder = listRef.current?.getScrollResponder() as unknown as ScrollView | null;
      responder?.scrollToEnd({ animated: false });
    });
  }, []);
  const markScrollIntent = useCallback((direction?: ScrollDirection) => {
    const followed = scrollPosition.current.shouldFollow;
    scrollPosition.current.beginInteraction(direction);
    if (scrollPosition.current.shouldFollow) {
      if (!followed) scrollToBottom();
      return;
    }
    if (scrollFrame.current !== null) { cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null; }
    if (direction === 'up' && scrollPosition.current.nearTop) loadEarlierRef.current();
  }, [scrollToBottom]);
  const nextImageKey = useRef(0);
  useEffect(() => () => { for (const upload of fileUploads.current.values()) upload.abort(); fileUploads.current.clear(); }, []);
  const moveImage = useCallback((direction: ImageDirection) => setPreview(current => {
    if (!current) return null;
    const index = current.index + direction;
    return index >= 0 && index < current.images.length ? { ...current, index } : current;
  }), []);

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
  useEffect(() => { if (view.phase === 'locked') { setDraft(''); setImages([]); setDrawerOpen(false); setActionThread(null); setPreview(null); setEditingQueueId(null); closeMenu(); } }, [view.phase]);
  useEffect(() => { if (view.phase === 'connected' && deviceId && !view.catalogs[deviceId]) void relay.loadCatalog(deviceId); }, [deviceId, view.catalogs, view.phase]);
  useEffect(() => {
    setPreview(null);
    setFiles([]);
    for (const upload of fileUploads.current.values()) upload.abort();
    fileUploads.current.clear();
    setEditingQueueId(null);
    olderAnchor.current = null;
    earlierRequest.current = null;
    scrollPosition.current.reset();
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
    return mergeTurnHistory(history?.turns ?? [], thread?.turns ?? []);
  }, [history?.turns, thread?.turns]);
  // Preserve the pre-update follow state across card insertion. Size callbacks
  // repeat this after virtualized rows and asynchronous content are measured.
  useLayoutEffect(() => {
    if (scrollPosition.current.shouldFollow) scrollToBottom();
  }, [turns, thread?.requests, scrollToBottom]);
  const galleryContext = useRef({ turns, deviceId, threadId });
  galleryContext.current = { turns, deviceId, threadId };
  const openImage = useCallback((source: ImagePreview['source'], name: string) => {
    const context = galleryContext.current;
    const entries: ImagePreview[] = conversationImages(context.turns).map(image => ({ source: relay.imageSource(context.deviceId, context.threadId, image.id), name: image.name }));
    let index = entries.findIndex(image => image.source.uri === source.uri);
    if (index < 0) { index = entries.length; entries.push({ source, name }); }
    setPreview({ images: entries, index });
  }, []);
  const openDraftImage = (index: number) => {
    setPreview({ images: images.map(image => ({ source: { uri: image.uri }, name: image.name })), index });
  };
  const changedTurn = thread?.status === 'active' ? turns.find(turn => turn.id === thread.activeTurnId && !!turn.fileChanges?.length) : undefined;
  const hasTruncatedContent = turns.some(turn => turn.truncated || turn.items.some(item => item.truncated));
  const rows = useMemo(() => buildDirectoryRows({catalog, snapshot, deviceId, expandedProjects, search}), [catalog, deviceId, expandedProjects, search, snapshot]);

  const connect = async (url: string, username: string, password: string) => { setLoginBusy(true); try { await relay.connect(url, username, password, true); } catch { /* Error appears in the login view. */ } finally { setLoginBusy(false); } };
  const selectThread = (id: string) => { setThreadId(id); setDraft(''); setImages([]); setDrawerOpen(false); };
  const createProject = async (payload: Extract<RemoteCommand['payload'], { type: 'project.create' }>) => {
    const target = projectDeviceId;
    setManaging(true);
    try {
      const result = await relay.sendCommand(target, payload);
      if (result.status !== 'succeeded' || typeof result.result?.projectId !== 'string') throw new Error(result.code);
      const projectId = result.result.projectId;
      setSearch('');
      setExpandedProjects(current => [...new Set([...current, `${target}:${projectId}`])]);
      setProjectDeviceId('');
      setDrawerOpen(true);
      void relay.loadCatalog(target).catch(() => relay.showNotice('项目已创建，列表刷新失败，请重试刷新。'));
    } finally { setManaging(false); }
  };
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
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : String(error)); }
    finally { setManaging(false); }
  };
  const send = async (payload: RemoteCommand['payload'], clearDraft = false) => {
    if (busy) return false;
    setBusy(true);
    const scope = currentStreamKey.current;
    try {
      const result = await relay.sendCommand(deviceId, payload);
      if (result.status !== 'succeeded') throw new Error(result.code);
      if (clearDraft && scope === currentStreamKey.current) { setDraft(''); setImages([]); setFiles([]); }
      return true;
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : String(error)); return false; }
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
    const scope = currentStreamKey.current;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: MAX_IMAGES - images.length, base64: true, quality: 0.85 });
      if (!result.canceled && scope === currentStreamKey.current) addImages(result.assets);
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : '无法读取图片'); }
  };
  const pickCamera = async () => {
    const scope = currentStreamKey.current;
    try {
      if (Platform.OS !== 'web' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) { relay.showNotice('请允许相机权限，或选择照片'); return; }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], base64: true, quality: 0.85 });
      if (!result.canceled && scope === currentStreamKey.current) addImages(result.assets);
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : '无法打开相机'); }
  };
  const uploadFile = async (file: DraftAttachment, targetDevice = deviceId, targetThread = threadId) => {
    const abort = new AbortController(); fileUploads.current.get(file.key)?.abort(); fileUploads.current.set(file.key, abort);
    setFiles(current => current.map(item => item.key === file.key ? { ...item, loading: true, error: undefined } : item));
    try {
      const uploaded = await relay.uploadAttachment(targetDevice, targetThread, file.asset, abort.signal);
      if (!abort.signal.aborted) setFiles(current => current.map(item => item.key === file.key ? { ...item, id: uploaded.id, loading: false } : item));
    } catch (error) {
      if (!abort.signal.aborted) setFiles(current => current.map(item => item.key === file.key ? { ...item, loading: false, error: '上传失败，点击重试' } : item));
    } finally { if (fileUploads.current.get(file.key) === abort) fileUploads.current.delete(file.key); }
  };
  const pickFiles = async () => {
    const scope = currentStreamKey.current, targetDevice = deviceId, targetThread = threadId;
    try {
      const assets = await pickAttachments();
      if (scope !== currentStreamKey.current) return;
      for (const asset of assets.slice(0, MAX_ATTACHMENTS - files.length)) {
        if (asset.size > MAX_ATTACHMENT_BYTES) { relay.showNotice(`${asset.name} 超过 20 MB`); continue; }
        const file: DraftAttachment = { key: ++nextImageKey.current, asset, loading: true };
        setFiles(current => [...current, file]); void uploadFile(file, targetDevice, targetThread);
      }
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : '无法读取文件'); }
  };
  const removeFile = (file: DraftAttachment) => {
    fileUploads.current.get(file.key)?.abort();
    setFiles(current => current.filter(item => item.key !== file.key));
    if (file.id) void relay.removeAttachment(deviceId, threadId, file.id).catch(() => {});
  };
  const submit = () => {
    if (!thread || busy || !ready || images.some(image => image.loading || image.error) || files.some(file => file.loading || file.error || !file.id)) return;
    const text = draft.trim(), ids = images.map(image => image.id).filter((id): id is string => !!id);
    const attachments = files.flatMap(file => file.id ? [file.id] : []);
    if (!text && !ids.length && !attachments.length) { if (thread.status === 'active' && thread.activeTurnId) void send({ type: 'turn.interrupt', threadId, turnId: thread.activeTurnId }); return; }
    void send({ type: thread.status === 'active' ? 'turn.queue' : 'turn.start', threadId, text, ...(ids.length ? { images: ids } : {}), ...(attachments.length ? { attachments } : {}) }, true);
  };
  const changeModel = async (model: string) => { if (thread?.settings?.model && thread.status === 'idle' && model !== thread.settings.model) await send({ type: 'thread.model.update', threadId, model, expectedModel: thread.settings.model }); };
  const changeEffort = async (effort: string) => { if (thread?.settings?.model && thread.status === 'idle' && effort !== thread.settings.reasoningEffort) return send({ type: 'thread.effort.update', threadId, effort: effort as Extract<RemoteCommand['payload'], { type: 'thread.effort.update' }>['effort'], expectedModel: thread.settings.model, expectedEffort: thread.settings.reasoningEffort }); return false; };
  const changeMode = (mode: 'default' | 'plan') => {
    closeMenu();
    if (thread?.settings?.model && thread.status === 'idle' && snapshot?.runtime.capabilities.collaborationModeUpdate && mode !== thread.settings.collaborationMode) void send({ type: 'thread.mode.update', threadId, mode, expectedMode: thread.settings.collaborationMode ?? null, expectedModel: thread.settings.model, expectedEffort: thread.settings.reasoningEffort });
  };
  const loadEarlier = () => {
    if (!deviceId || !threadId || !device?.online || view.phase !== 'connected' || !history?.nextCursor || history.loading || earlierRequest.current || olderAnchor.current) return;
    const request = { key: streamKey, cursor: history.nextCursor };
    earlierRequest.current = request;
    scrollPosition.current.pause();
    if (scrollFrame.current !== null) { cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null; }
    const anchor = ['web', 'windows', 'macos'].includes(Platform.OS) ? {...scrollPosition.current.metrics} : null;
    olderAnchor.current = anchor;
    const firstTurn = history.turns[0]?.id;
    void relay.loadHistory(deviceId, threadId, true).finally(() => {
      if (earlierRequest.current !== request) return;
      earlierRequest.current = null;
      const latest = relay.getSnapshot().histories[request.key];
      if (latest?.error || latest?.turns[0]?.id === firstTurn) {
        if (olderAnchor.current === anchor) olderAnchor.current = null;
      }
    });
  };
  loadEarlierRef.current = loadEarlier;

  const directory = <Directory view={view} deviceId={deviceId} threadId={threadId} rows={rows} search={search} wide={wide} managing={managing} paddingTop={wide ? 0 : insets.top} paddingBottom={wide ? 0 : insets.bottom} setSearch={setSearch}
    selectDevice={id => { setDeviceId(id); setDraft(''); setImages([]); }} selectThread={selectThread}
    toggleProject={id => setExpandedProjects(current => current.includes(`${deviceId}:${id}`) ? current.filter(value => value !== `${deviceId}:${id}`) : [...current, `${deviceId}:${id}`])}
    createProject={() => { setProjectDeviceId(deviceId); setDrawerOpen(false); }} createThread={id => void createThread(id)} threadActions={item => { setDrawerOpen(false); setNewName(item.title); setActionThread({ id: item.id, title: item.title }); }}
    updateAvailable={clientUpdates.available} close={() => setDrawerOpen(false)} settings={() => { setDrawerOpen(false); openMenu('settings'); }} refresh={() => void relay.refreshDevices()} />;

  if (restoring) return <SafeAreaView style={[s.safe, s.center]}><ActivityIndicator color={c.accent} /></SafeAreaView>;
  if (view.phase === 'locked') return <Login connect={connect} busy={loginBusy} error={view.notice} />;
  const stopMode = thread?.status === 'active' && !draft.trim() && !images.length && !files.length;
  const settings = thread?.settings ?? summary?.settings;
  return <View style={s.safe}><StatusBar style={theme.dark ? "light" : "dark"} />
    <FileViewerProvider deviceId={deviceId} threadId={threadId}><PreviewContext.Provider value={{deviceId, threadId}}><ConversationDrawer wide={wide} open={drawerOpen} onOpenChange={setDrawerOpen} directory={directory}>
    <SafeAreaView style={s.page} edges={['top', 'left', 'right', 'bottom']}>
    <KeyboardAvoidingView style={s.page} behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}>
      <DrawerSwipeArea>
      <ConversationHeader title={summary?.title ?? thread?.title ?? 'Codexer'} subtitle={`${project?.name ?? device?.name ?? '选择设备'}${threadId ? ` · ${thread?.status === 'active' ? '进行中' : thread?.status === 'idle' ? '空闲' : '接入中'}` : ''}`}
        deviceId={deviceId} threadId={threadId} agents={conversationSubAgents(thread, turns)} supported={!!snapshot?.runtime.capabilities.subAgents}
        synchronized={view.phase === 'connected' && !!device?.online && !!snapshot?.runtime.connected && !!thread?.ownerAvailable && !view.syncing[deviceId]}
        truncated={!!thread?.subAgentsTruncated} hasTruncatedContent={hasTruncatedContent} onDrawer={wide ? undefined : () => setDrawerOpen(true)}
        onRefresh={() => { void relay.loadHistory(deviceId, threadId); relay.watchThread(deviceId, threadId); }}
        onInfo={() => relay.showNotice('部分长记录受传输大小限制。完整内容可在本机 Codex 查看；更早消息可在会话顶部加载。')} />
      <ConversationViewport onScrollIntent={markScrollIntent}><FlatList key={historyKey(deviceId, threadId)} ref={listRef} testID="conversation-stream" data={turns} keyExtractor={item => item.id} style={s.stream} contentContainerStyle={[s.streamContent, wide && s.desktopContent]} initialNumToRender={8} windowSize={7} maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onScroll={event => {
          if (currentStreamKey.current !== streamKey) return;
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          const previous = scrollPosition.current.metrics;
          setShowJumpToBottom(scrollPosition.current.readScroll({height: contentSize.height, offset: contentOffset.y, viewport: layoutMeasurement.height}));
          if (scrollPosition.current.shouldFollow) {
            // A scroll offset alone must not create another scroll-to-end loop.
            // Follow new geometry; explicit input can always leave a settled list.
            if ((previous.height !== contentSize.height || previous.viewport !== layoutMeasurement.height) && contentSize.height - layoutMeasurement.height - contentOffset.y > 1) scrollToBottom();
          } else if (contentOffset.y < previous.offset - 1 && scrollPosition.current.nearTop) loadEarlierRef.current();
        }} scrollEventThrottle={32}
        onScrollBeginDrag={Platform.OS === 'web' ? undefined : () => markScrollIntent()}
        onLayout={event => {
          if (currentStreamKey.current !== streamKey) return;
          setShowJumpToBottom(scrollPosition.current.layout(event.nativeEvent.layout.height));
          if (scrollPosition.current.shouldFollow) scrollToBottom();
        }}
        onContentSizeChange={(_width, height) => {
          if (currentStreamKey.current !== streamKey) return;
          setShowJumpToBottom(scrollPosition.current.contentSize(height));
          if (olderAnchor.current && !history?.loading) {
            const anchor = olderAnchor.current; olderAnchor.current = null;
            listRef.current?.scrollToOffset({offset: Math.max(0, anchor.offset + height - anchor.height), animated: false});
          } else if (scrollPosition.current.shouldFollow) scrollToBottom();
        }} refreshing={!!history?.nextCursor && !!history.loading}
        onRefresh={Platform.OS !== 'web' && history?.nextCursor ? loadEarlier : undefined}
        renderItem={({ item }) => <TurnView turn={item} active={item.id === thread?.activeTurnId && thread?.status === 'active'} deviceId={deviceId} threadId={threadId} onImage={openImage} questionRequestIds={questionRequestIds} />}
        ListHeaderComponent={history?.nextCursor ? <Pressable accessibilityRole="button" accessibilityLabel="加载更早消息" disabled={history.loading} onPress={loadEarlier} style={s.earlier}>{history.loading ? <ActivityIndicator size="small" color={c.accent} /> : <Text style={s.earlierText}>{Platform.OS === 'web' ? '加载更早消息' : '下拉加载更早消息'}</Text>}</Pressable> : null}
        ListEmptyComponent={<View style={s.chatEmpty}><Terminal size={30} color={c.accent} /><Text style={s.chatEmptyTitle}>{threadId ? history?.loading ? '正在读取会话' : '开始对话' : view.devices.length ? '选择 PC Agent 和会话' : '等待 PC Agent 登录'}</Text><Text style={s.chatEmptySub}>{threadId ? '消息将在这里显示' : view.devices.length ? '从左侧选择要控制的 PC Agent' : '在 PC 上使用同一账号登录，即可在这里选择控制端'}</Text></View>}
        ListFooterComponent={<View>{!!history?.error && <Text style={s.error}>{history.error}</Text>}{thread?.requests.map(request => <DrawerSwipeBlock key={request.id}><RequestPanel request={request} threadId={threadId} enabled={ready && !busy} send={async payload => { const result = await relay.sendCommand(deviceId, payload); if (result.status !== 'succeeded') throw new Error(result.code); }} /></DrawerSwipeBlock>)}</View>} /></ConversationViewport>
      </DrawerSwipeArea>
      <View testID="composer-dock" style={[s.composerDock, wide && {maxWidth: 900, alignSelf: 'center'}]}>
        {showJumpToBottom && <Pressable accessibilityRole="button" accessibilityLabel="滚动到会话底部" style={s.jumpToBottom} onPress={scrollToBottom}><ArrowDown size={19} color={c.text} /></Pressable>}
        {!!changedTurn?.fileChanges?.length && <FileChangesPanel key={`${deviceId}:${threadId}:${changedTurn.id}`} changes={changedTurn.fileChanges} />}
      <View style={[s.composerStack, wide && { width: '94%', maxWidth: 864, alignSelf: 'center', marginBottom: 20 }]}>
        <QueuedMessages items={thread?.queuedMessages ?? []} enabled={ready && !busy} canSteer={!!thread?.activeTurnId}
          onSteer={queueId => { if (thread?.activeTurnId) void send({ type: 'turn.queue.steer', threadId, turnId: thread.activeTurnId, queueId }); }}
          onRemove={queueId => void send({ type: 'turn.queue.remove', threadId, queueId })} onEdit={setEditingQueueId} />
      <View style={s.composer}>{!!view.notice && <Text style={s.notice} numberOfLines={2}>{view.notice}</Text>}{!ready && <Text style={s.hint}>{!threadId ? '请选择会话' : view.phase === 'reconnecting' ? '正在重连服务器' : view.phase === 'connecting' ? '正在连接服务器' : !device?.online ? '设备离线' : view.syncing[deviceId] ? '同步中' : '正在接入会话'}</Text>}{!!images.length && <ScrollView horizontal style={s.draftStrip}>{images.map((image, index) => <View key={image.key} style={s.draftImage}><Pressable accessibilityRole="button" accessibilityLabel={`预览待发送图片 ${image.name}`} onPress={() => openDraftImage(index)}><Image source={{ uri: image.uri }} style={s.thumbnail} /></Pressable>{image.loading ? <ActivityIndicator size="small" /> : image.error ? <Pressable accessibilityRole="button" accessibilityLabel={`重试上传 ${image.name}`} disabled={!ready} onPress={() => void uploadDraft(image, deviceId, threadId)}><Text style={s.error}>{image.error} · 重试</Text></Pressable> : <Check size={14} color={c.accent} />}<Pressable accessibilityRole="button" accessibilityLabel={`移除 ${image.name}`} onPress={() => setImages(current => current.filter(item => item.key !== image.key))}><X size={17} color={c.muted} /></Pressable></View>)}</ScrollView>}
        {!!files.length && <ScrollView horizontal style={s.draftStrip} contentContainerStyle={{ gap: 8, padding: 4 }}>{files.map(file => <View key={file.key} style={s.draftFile}>
          <Paperclip size={20} color={c.muted} /><View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={s.menuText}>{file.asset.name}</Text><Text style={s.sub}>{file.asset.size < 1024 * 1024 ? `${Math.ceil(file.asset.size / 1024)} KB` : `${(file.asset.size / 1024 / 1024).toFixed(1)} MB`}</Text>
          {!!file.error && <Pressable accessibilityRole="button" accessibilityLabel={`重试上传文件 ${file.asset.name}`} disabled={!ready} onPress={() => void uploadFile(file)}><Text style={s.error}>{file.error}</Text></Pressable>}</View>
          {file.loading ? <ActivityIndicator size="small" color={c.muted} /> : !file.error && <Check size={15} color={c.accent} />}
          <Pressable accessibilityRole="button" accessibilityLabel={`移除文件 ${file.asset.name}`} onPress={() => removeFile(file)} style={s.iconButton}><X size={17} color={c.muted} /></Pressable>
        </View>)}</ScrollView>}
        <ComposerInput accessibilityLabel="给 Codex 发送消息" style={s.composerInput} value={draft} onChangeText={setDraft} multiline maxLength={32000} editable={!!ready && !busy} placeholder="给 Codex 发送消息" placeholderTextColor={c.muted} textAlignVertical="top" onImages={addImages} imagesEnabled={ready && !busy && !!snapshot?.runtime.capabilities.images && images.length < MAX_IMAGES} onImageError={message => relay.showNotice(message)} onSubmitEditing={Platform.OS === 'windows' ? () => submit() : undefined} onKeyPress={event => { const key = event.nativeEvent as { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }; if (Platform.OS === 'web' && key.key === 'Enter' && !key.shiftKey && !key.isComposing && key.keyCode !== 229) { event.preventDefault(); submit(); } }} />
        <View style={s.toolbar}><AttachmentMenu key={`attachments:${deviceId}:${threadId}`} enabled={ready && !busy} imagesEnabled={ready && !busy && !!snapshot?.runtime.capabilities.images && images.length < MAX_IMAGES} filesSupported={!!snapshot?.runtime.capabilities.attachments} filesEnabled={ready && !busy && !!snapshot?.runtime.capabilities.attachments && files.length < MAX_ATTACHMENTS} onImages={() => void pickImages()} onCamera={() => void pickCamera()} onFiles={() => void pickFiles()} />{!!snapshot?.runtime.capabilities.collaborationModeUpdate && <Pressable accessibilityRole="button" accessibilityLabel={`工作模式：${settings?.collaborationMode === 'plan' ? 'Plan' : '默认'}`} style={[s.pill, s.modePill, settings?.collaborationMode === 'plan' && s.modeActive]} disabled={!ready || busy || thread?.status !== 'idle'} onPress={() => openMenu('mode')}><ListChecks size={15} color={settings?.collaborationMode === 'plan' ? c.accent : c.muted} /><Text style={s.pillText}>{settings?.collaborationMode === 'plan' ? 'Plan' : '默认'}</Text></Pressable>}
          {!!snapshot?.runtime.capabilities.permissionsUpdate && !!settings?.permissions && <Pressable accessibilityRole="button" accessibilityLabel={`会话权限：${permissionLabels[settings.permissions.mode]}`} style={s.pill} disabled={!ready || busy} onPress={() => openMenu('permissions')}><Text style={s.pillText}>{permissionLabels[settings.permissions.mode]}</Text></Pressable>}
          <View style={s.spacer} /><ModelEffortPicker key={`model:${deviceId}:${threadId}`} model={settings?.model} effort={settings?.reasoningEffort} options={catalog?.models ?? []} enabled={ready && thread?.status === 'idle'} busy={busy} onModelChange={changeModel} onEffortChange={changeEffort} />
          <Pressable accessibilityRole="button" accessibilityLabel={stopMode ? '停止当前任务' : thread?.status === 'active' ? '添加到待发送' : '发送消息'} disabled={!ready || busy || images.some(image => image.loading || !!image.error) || files.some(file => file.loading || !!file.error || !file.id)} onPress={submit} style={[s.send, stopMode && s.stop, (!ready || busy) && s.disabled]}>{busy ? <ActivityIndicator color={c.onSolid} size="small" /> : stopMode ? <Square size={18} color={c.onSolid} fill={c.onSolid} /> : <ArrowUp size={20} color={c.onSolid} />}</Pressable></View>
      </View>
      </View>
      </View>
    </KeyboardAvoidingView>
    </SafeAreaView>
    </ConversationDrawer></PreviewContext.Provider></FileViewerProvider>
    {editingQueueId && <QueueEditor key={`${deviceId}:${threadId}:${editingQueueId}`} deviceId={deviceId} threadId={threadId} queueId={editingQueueId} onClose={() => setEditingQueueId(null)} />}
    {!!projectDeviceId && <ProjectCreate key={projectDeviceId} catalog={view.catalogs[projectDeviceId]} online={!!view.devices.find(item => item.id === projectDeviceId)?.online} create={createProject} close={() => setProjectDeviceId('')} />}
    <Dialog open={!!actionThread} title={renaming ? '重命名会话' : actionThread?.title ?? '会话操作'} busy={managing} onClose={() => { setActionThread(null); setRenaming(false); }}>
          {renaming ? <><TextInput style={s.field} value={newName} onChangeText={setNewName} autoFocus maxLength={1000} /><Pressable style={[s.primary, (!newName.trim() || managing) && s.disabled]} disabled={!newName.trim() || managing} onPress={() => actionThread && void manageThread({ type: 'thread.rename', threadId: actionThread.id, name: newName.trim() })}><Text style={s.primaryText}>保存</Text></Pressable></> : <>
            {actionThread && <ConversationId key={actionThread.id} threadId={actionThread.id} />}
            <Pressable style={s.menuOption} disabled={managing} onPress={() => setRenaming(true)}><Pencil size={18} color={c.text} /><Text style={s.menuText}>重命名</Text></Pressable>
            <Pressable style={s.menuOption} disabled={managing} onPress={() => actionThread && void manageThread({ type: 'thread.archive', threadId: actionThread.id })}><Archive size={18} color={c.text} /><Text style={s.menuText}>归档</Text></Pressable>
            <Pressable style={s.menuOption} disabled={managing} onPress={() => { const target = actionThread; if (target) void confirmAction('永久删除会话', `删除“${target.title}”后无法恢复。`).then(confirmed => { if (confirmed) void manageThread({ type: 'thread.delete', threadId: target.id }); }); }}><Trash2 size={18} color={c.danger} /><Text style={s.dangerText}>永久删除</Text></Pressable>
          </>}
    </Dialog>
    <SettingsShell open={menuOpen&&menu==='settings'} onClose={closeMenu} onWeixin={()=>setMenu('weixin')} updateAvailable={clientUpdates.available}>{section=><ControlSettings section={section} url={view.url} device={device&&{name:device.name,online:device.online,agentVersion:snapshot?.agentVersion}} onWeixin={()=>setMenu('weixin')} onLogout={()=>{closeMenu();void relay.logout().catch(()=>{});}}/>}</SettingsShell>
    <Dialog open={menuOpen&&menu!=='settings'} title={menu === 'weixin' ? '微信设置' : menu === 'permissions' ? '会话权限' : '工作模式'} onClose={closeMenu}>
        {menu === 'weixin' ? menuOpen && <WeixinSettings />
          : menu === 'permissions' ? menuOpen && !!settings?.permissions && <PermissionPicker key={`${deviceId}:${threadId}`} settings={settings.permissions} enabled={ready && !busy && thread?.status === 'idle'} onChange={async mode => {
            if (!thread?.settings?.permissions) return false;
            const ok = await send({type: 'thread.permissions.update', threadId, mode, expectedPermissions: thread.settings.permissions.fingerprint});
            if (ok) closeMenu();
            return ok;
          }} />
          : <View><Pressable style={s.menuOption} onPress={() => changeMode('default')}><View style={{flex: 1}}><Text style={s.menuText}>默认模式</Text><Text style={s.sub}>按请求执行任务</Text></View>{settings?.collaborationMode === 'default' && <Check size={18} color={c.accent} />}</Pressable><Pressable style={s.menuOption} onPress={() => changeMode('plan')}><View style={{flex: 1}}><Text style={s.menuText}>Plan Mode</Text><Text style={s.sub}>先讨论和形成计划，再切换默认模式执行</Text></View>{settings?.collaborationMode === 'plan' && <Check size={18} color={c.accent} />}</Pressable></View>}
    </Dialog>
    <ImageViewer preview={preview} onClose={() => setPreview(null)} onNavigate={moveImage} />
  </View>;
}

export default function App() { return <ThemeProvider><SafeAreaProvider><AppContent /></SafeAreaProvider></ThemeProvider>; }
