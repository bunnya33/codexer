import {ProjectBrowseContext} from './src/project-browser-context';
import { ThemeProvider } from './src/theme';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Archive, ArrowDown, Check, Pencil, Terminal, Trash2 } from 'lucide-react-native';
import { mergeTurnHistory } from '../../packages/client-shared/src/activity';
import {JumpToBottom} from './src/interaction/jump-to-bottom';
import { currentThreadUsage } from '../../packages/client-shared/src/project-usage';
import { conversationImages } from '../../packages/client-shared/src/images';
import type { ImageDirection, ImageGallery, ImagePreview } from '../../packages/client-shared/src/images';
import { buildDirectoryRows } from '../../packages/client-shared/src/directory';
import { MAX_IMAGES, MAX_IMAGE_BYTES } from '../../packages/protocol/src/index';
import type { HistoryTurn, RemoteCommand } from '../../packages/protocol/src/index';
import { FileChangesPanel, RequestPanel, TurnView } from './src/conversation';
import { RequestDraftProvider } from './src/request-drafts';
import { completePlan, PlanPreparationContext } from './src/plan-review';
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
import { ProjectActions } from './src/project-actions';
import { ProjectBrowser } from './src/project-browser';
import { confirmAction, defaultRelayUrl } from './src/runtime';
import { ConversationControls } from './src/conversation-controls';
import { ConversationViewport } from './src/conversation-viewport';
import { ConversationDrawer } from './src/conversation-drawer';
import { DrawerSwipeArea } from './src/drawer-swipe-area';
import { DrawerSwipeBlock } from './src/drawer-swipe-block';
import { ConversationScroll } from '../../packages/client-shared/src/conversation-scroll';
import type { ScrollDirection } from '../../packages/client-shared/src/conversation-scroll';
import { useConversationSelection } from './src/conversation-selection';
import { WeixinSettings } from './src/weixin-settings';
import { QueuedMessages } from './src/queued-messages';
import { QueueEditor } from './src/queue-editor';
import { Dialog } from './src/dialog';
import { ControlSettings } from './src/control-settings';
import {SettingsShell} from './src/settings-shell';
import {useClientUpdates} from './src/client-updates';
import { pickAttachments } from './src/attachment-picker';
import { pickMedia } from './src/media-picker';
import type { AttachmentAsset } from './src/attachment-picker';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, attachmentByteLimit } from '../../packages/protocol/src/uploads';
import { useConversationDraft } from './src/conversation-drafts';
import type { DraftImage, DraftAttachment } from './src/conversation-drafts';

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
  const selectedDevice = useRef(deviceId);
  selectedDevice.current = deviceId;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const draftScope = view.phase !== 'locked' && view.userId ? JSON.stringify([view.url, view.userId]) : '';
  const { draft: composerDraft, setText: setDraft, setImages, setFiles, getDraft, isCurrent: draftIsCurrent, clearSubmitted, preparePlan, removePreparedPlan } = useConversationDraft(draftScope, deviceId, threadId);
  const { text: draft, images, files } = composerDraft;
  const fileUploads = useRef(new Map<number, AbortController>());
  const imageUploads = useRef(Promise.resolve());
  const [busy, setBusy] = useState(false);
  const commandLock = useRef(false);
  const [menu, setMenu] = useState<'settings' | 'weixin'>('settings');
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
  const [actionProject, setActionProject] = useState<{ deviceId: string; id: string; name: string } | null>(null);
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
    olderAnchor.current = null;
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
  useEffect(() => () => { for (const upload of fileUploads.current.values()) upload.abort(); fileUploads.current.clear(); }, [draftScope]);
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
  useEffect(() => { if (view.phase === 'locked') { setDrawerOpen(false); setActionThread(null); setActionProject(null); setProjectDeviceId(''); setPreview(null); setEditingQueueId(null); closeMenu(); } }, [view.phase]);
  useEffect(() => { setActionProject(null); }, [deviceId]);
  useEffect(() => { if (view.phase === 'connected' && deviceId && !view.catalogs[deviceId]) void relay.loadCatalog(deviceId); }, [deviceId, view.catalogs, view.phase]);
  useEffect(() => {
    setPreview(null);
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
  const [browserProject,setBrowserProject]=useState<{deviceId:string;id:string;open:boolean}>();
  const snapshot = view.snapshots[deviceId];
  const imageLimit = Math.min(MAX_IMAGES, snapshot?.runtime.capabilities.maxImages ?? 4);
  const videoLimit = snapshot?.runtime.capabilities.maxVideoBytes ?? MAX_ATTACHMENT_BYTES;
  const thread = snapshot?.threads[threadId];
  const questionRequestIds = useMemo(() => thread?.requests.filter(request => request.details.source === 'asyncMessage').map(request => request.id) ?? [], [thread?.requests]);
  const summary = catalog?.threads.find(item => item.id === threadId);
  const project = catalog?.projects.find(item => item.id === summary?.projectId);
  const history = view.histories[historyKey(deviceId, threadId)];
  useEffect(() => { if (view.phase === 'connected' && deviceId && threadId && device?.online && !view.syncing[deviceId]) { relay.watchThread(deviceId, threadId); if (!history || history.error) void relay.loadHistory(deviceId, threadId); } }, [view.phase, deviceId, threadId, device?.online, view.syncing[deviceId], snapshot?.epoch, thread?.ownerAvailable]);
  useEffect(() => { if (view.phase !== 'connected' || !deviceId || !threadId || !device?.online || view.syncing[deviceId] || thread?.ownerAvailable) return; const timer = setInterval(() => relay.watchThread(deviceId, threadId), 16000); return () => clearInterval(timer); }, [view.phase, deviceId, threadId, device?.online, view.syncing[deviceId], thread?.ownerAvailable]);
  const ready = view.phase === 'connected' && !!device?.online && !view.syncing[deviceId] && !!thread?.ownerAvailable && ['idle', 'active'].includes(thread.status);
  const turns = useMemo(() => {
    return mergeTurnHistory(history?.turns ?? [], thread?.turns ?? [], 'latest', thread?.status === 'active' ? thread.activeTurnId : null);
  }, [history?.turns, thread?.turns, thread?.status, thread?.activeTurnId]);
  const chatUsage = useMemo(() => currentThreadUsage(thread?.usage, thread?.tokenUsage, turns), [thread?.usage, thread?.tokenUsage, turns]);
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
  const rows = useMemo(() => buildDirectoryRows({catalog, snapshot: device?.online ? snapshot : undefined, deviceId, expandedProjects, search}), [catalog, device?.online, deviceId, expandedProjects, search, snapshot]);

  const connect = async (url: string, username: string, password: string) => { setLoginBusy(true); try { await relay.connect(url, username, password, true); } catch { /* Error appears in the login view. */ } finally { setLoginBusy(false); } };
  const selectThread = (id: string) => { setThreadId(id); setDrawerOpen(false); };
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
  const createThread = async (projectId: string, target = deviceId) => {
    if (managing) return;
    setManaging(true);
    try {
      const result = await relay.sendCommand(target, { type: 'thread.create', projectId });
      if (result.status !== 'succeeded' || typeof result.result?.threadId !== 'string') throw new Error(result.code);
      await relay.loadCatalog(target);
      if (selectedDevice.current === target) selectThread(result.result.threadId);
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
    if (commandLock.current) return false;
    commandLock.current = true; setBusy(true);
    // Sending is a new request to follow, even after reading earlier messages.
    // Do this before awaiting the command: output may arrive before its result,
    // and later user scrolling must still be allowed to pause following.
    if (['turn.start', 'turn.steer', 'turn.continue', 'turn.queue.steer'].includes(payload.type)) scrollToBottom();
    try {
      const result = await relay.sendCommand(deviceId, payload);
      if (result.status !== 'succeeded') throw new Error(result.code);
      if (clearDraft) clearSubmitted(composerDraft);
      return true;
    } catch (error) { if (draftIsCurrent()) relay.showNotice(error instanceof Error ? error.message : String(error)); return false; }
    finally { commandLock.current = false; setBusy(false); }
  };
  const uploadDraft = async (image: DraftImage, targetDeviceId: string, targetThreadId: string) => {
    const asset = image.asset;
    if (!asset || !draftIsCurrent()) return;
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
      if (!draftIsCurrent()) return;
      const uploaded = await relay.uploadImage(targetDeviceId, targetThreadId, { name, mimeType, base64 });
      setImages(current => current.map(item => item.key === image.key ? { key: item.key, uri: item.uri, name, id: uploaded.id, loading: false } : item));
    } catch (error) {
      const code = error instanceof Error ? error.message : '上传失败';
      setImages(current => current.map(item => item.key === image.key ? { ...item, loading: false, error: code === 'request-too-large' ? '图片请求过大' : code === 'invalid-image' ? '图片格式无效' : code } : item));
    }
  };
  const addImages = (assets: ImagePicker.ImagePickerAsset[]) => {
    if (!draftIsCurrent()) return;
    const slots = Math.max(0, imageLimit - getDraft().images.length);
    if (assets.length > slots) relay.showNotice(`最多添加 ${imageLimit} 张图片`);
    for (const asset of assets.slice(0, slots)) {
      const image: DraftImage = { key: ++nextImageKey.current, uri: asset.uri, name: (asset.fileName ?? 'image').slice(0, 255), asset, loading: true };
      setImages(current => [...current, image]);
      imageUploads.current = imageUploads.current.catch(() => {}).then(async () => {
        if (draftIsCurrent() && getDraft().images.some(item => item.key === image.key)) await uploadDraft(image, deviceId, threadId);
      });
    }
  };
  const pickPhotosAndVideos = async () => {
    const scope = currentStreamKey.current;
    try {
      const result = await pickMedia({ imageSlots: snapshot?.runtime.capabilities.images ? Math.max(0, imageLimit - images.length) : 0,
        videoSlots: snapshot?.runtime.capabilities.attachments ? Math.max(0, MAX_ATTACHMENTS - files.length) : 0 });
      if (!draftIsCurrent() || scope !== currentStreamKey.current) return;
      addImages(result.images); addFiles(result.videos);
    } catch (error) { if (draftIsCurrent()) relay.showNotice(error instanceof Error ? error.message : '无法读取图片或视频'); }
  };
  const pickCamera = async () => {
    const scope = currentStreamKey.current;
    try {
      if (Platform.OS !== 'web' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) { relay.showNotice('请允许相机权限，或选择照片'); return; }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], base64: true, quality: 0.85 });
      if (!result.canceled && draftIsCurrent() && scope === currentStreamKey.current) addImages(result.assets);
    } catch (error) { if (draftIsCurrent()) relay.showNotice(error instanceof Error ? error.message : '无法打开相机'); }
  };
  const uploadFile = async (file: DraftAttachment, targetDevice = deviceId, targetThread = threadId) => {
    if (!draftIsCurrent()) return;
    const abort = new AbortController(); fileUploads.current.get(file.key)?.abort(); fileUploads.current.set(file.key, abort);
    setFiles(current => current.map(item => item.key === file.key ? { ...item, loading: true, error: undefined } : item));
    try {
      const uploaded = await relay.uploadAttachment(targetDevice, targetThread, file.asset, abort.signal);
      if (!abort.signal.aborted) setFiles(current => current.map(item => item.key === file.key ? { ...item, id: uploaded.id, loading: false } : item));
    } catch (error) {
      if (!abort.signal.aborted) setFiles(current => current.map(item => item.key === file.key ? { ...item, loading: false, error: '上传失败，点击重试' } : item));
    } finally { if (fileUploads.current.get(file.key) === abort) fileUploads.current.delete(file.key); }
  };
  const addFiles = (assets: AttachmentAsset[], targetDevice = deviceId, targetThread = threadId) => {
    if (!draftIsCurrent()) return;
    const slots = Math.max(0, MAX_ATTACHMENTS - getDraft().files.length);
    if (assets.length > slots) relay.showNotice(`最多添加 ${MAX_ATTACHMENTS} 个文件或视频`);
    for (const asset of assets.slice(0, slots)) {
      const limit = Math.min(attachmentByteLimit(asset), videoLimit);
      if (!Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > limit) { relay.showNotice(`${asset.name} 不能超过 ${limit / 1024 / 1024} MB${limit < attachmentByteLimit(asset) ? '，请更新电脑连接器以发送较大的视频' : ''}`); continue; }
      const file: DraftAttachment = { key: ++nextImageKey.current, asset, loading: true };
      setFiles(current => [...current, file]); void uploadFile(file, targetDevice, targetThread);
    }
  };
  const pickFiles = async (kind?: 'video') => {
    const scope = currentStreamKey.current, targetDevice = deviceId, targetThread = threadId;
    try {
      const assets = await pickAttachments(kind);
      if (!draftIsCurrent() || scope !== currentStreamKey.current) return;
      addFiles(assets, targetDevice, targetThread);
    } catch (error) { if (draftIsCurrent()) relay.showNotice(error instanceof Error ? error.message : '无法读取文件'); }
  };
  const removeFile = (file: DraftAttachment) => {
    fileUploads.current.get(file.key)?.abort();
    setFiles(current => current.filter(item => item.key !== file.key));
    if (file.id) void relay.removeAttachment(deviceId, threadId, file.id).catch(() => {});
  };
  const activeSettingsEnabled = thread?.status === 'idle' || (thread?.status === 'active' && snapshot?.runtime.capabilities.activeSettingsUpdate === true);
  const interruptedTurn = thread?.status === 'idle' && thread.turns.at(-1)?.status === 'interrupted' ? thread.turns.at(-1) : undefined;
  const canContinue = !!interruptedTurn && snapshot?.runtime.capabilities.continueTurn === true;
  const executePrepared = async (input: Extract<RemoteCommand['payload'], { type: 'turn.start' }>) => {
    if (commandLock.current || !composerDraft.preparedPlan) return;
    const plan = composerDraft.preparedPlan, selectedStream = streamKey;
    commandLock.current = true; setBusy(true);
    let switched = false;
    const current = () => {
      const latest = relay.getSnapshot(), pc = latest.snapshots[deviceId], target = pc?.threads[threadId];
      if (!draftIsCurrent() || currentStreamKey.current !== selectedStream || getDraft() !== composerDraft) throw new Error('草稿或会话已变化，待执行内容已保留，请重新发送。');
      if (latest.phase !== 'connected' || !latest.devices.find(d => d.id === deviceId)?.online || latest.syncing[deviceId] || !target?.ownerAvailable || target.status !== 'idle') throw new Error('请等待设备连接且当前任务结束后，再执行此方案。');
      const sourceTurn = mergeTurnHistory(latest.histories[historyKey(deviceId, threadId)]?.turns ?? [], target.turns).find(turn => turn.id === plan.turnId);
      const source = sourceTurn?.items.find(item => item.id === plan.itemId);
      if (!source || !sourceTurn || !completePlan(source, sourceTurn.status) || source.text !== plan.text) throw new Error('方案内容已变化或尚未完整同步，请重新打开方案准备执行。');
      return { target, pc };
    };
    try {
      const { target, pc } = current();
      if (!target.settings?.model || !['plan', 'default'].includes(target.settings.collaborationMode ?? '')) throw new Error('会话模式尚未同步，请刷新后重试。');
      if (target.settings.collaborationMode === 'plan') {
        if (!pc?.runtime.capabilities.collaborationModeUpdate) throw new Error('当前连接器不支持切换模式，请更新连接器后重试。');
        const result = await relay.sendCommand(deviceId, { type: 'thread.mode.update', threadId, mode: 'default', expectedMode: 'plan', expectedModel: target.settings.model, expectedEffort: target.settings.reasoningEffort });
        if (result.status !== 'succeeded') throw new Error(result.code);
        switched = true;
      }
      if (current().target.settings?.collaborationMode !== 'default') throw new Error('模式尚未同步，请等待同步后重试。');
      scrollToBottom();
      const result = await relay.sendCommand(deviceId, input);
      if (result.status !== 'succeeded') throw new Error(result.code);
      clearSubmitted(composerDraft);
    } catch (error) {
      if (draftIsCurrent()) relay.showNotice(`${switched ? '已切换为默认模式；' : ''}${error instanceof Error ? error.message : String(error)} 草稿已保留。`);
    } finally { commandLock.current = false; setBusy(false); }
  };
  const submit = () => {
    if (!thread || busy || !ready || images.some(image => image.loading || image.error) || files.some(file => file.loading || file.error || !file.id)) return;
    const text = draft.trim(), ids = images.map(image => image.id).filter((id): id is string => !!id);
    const attachments = files.flatMap(file => file.id ? [file.id] : []);
    if (!text && !ids.length && !attachments.length) {
      if (thread.status === 'active' && thread.activeTurnId) void send({ type: 'turn.interrupt', threadId, turnId: thread.activeTurnId });
      else if (canContinue && interruptedTurn) void send({ type: 'turn.continue', threadId, turnId: interruptedTurn.id });
      return;
    }
    const input = { threadId, text, ...(ids.length ? { images: ids } : {}), ...(attachments.length ? { attachments } : {}) };
    if (composerDraft.preparedPlan) { if (thread.status === 'idle') void executePrepared({ type: 'turn.start', ...input }); return; }
    if (thread.status === 'active') {
      if (thread.activeTurnId) void send({ type: 'turn.steer', turnId: thread.activeTurnId, ...input }, true);
    } else void send({ type: 'turn.start', ...input }, true);
  };
  const changeModel = async (model: string) => {
    if (!ready || !thread?.settings?.model || !activeSettingsEnabled || !snapshot?.runtime.capabilities.modelUpdate) return false;
    if (model === thread.settings.model) return true;
    return send({ type: 'thread.model.update', threadId, model, expectedModel: thread.settings.model });
  };
  const changeEffort = async (effort: string) => {
    if (!ready || !thread?.settings?.model || !activeSettingsEnabled || !snapshot?.runtime.capabilities.effortUpdate) return false;
    if (effort === thread.settings.reasoningEffort) return true;
    return send({ type: 'thread.effort.update', threadId, effort: effort as Extract<RemoteCommand['payload'], { type: 'thread.effort.update' }>['effort'], expectedModel: thread.settings.model, expectedEffort: thread.settings.reasoningEffort });
  };
  const changeMode = async (mode: 'default' | 'plan') => {
    if (!ready || !thread?.settings?.model || thread.status !== 'idle' || !snapshot?.runtime.capabilities.collaborationModeUpdate) return false;
    if (mode === thread.settings.collaborationMode) return true;
    return send({ type: 'thread.mode.update', threadId, mode, expectedMode: thread.settings.collaborationMode ?? null, expectedModel: thread.settings.model, expectedEffort: thread.settings.reasoningEffort });
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
    selectDevice={setDeviceId} selectThread={selectThread}
    toggleProject={id => setExpandedProjects(current => current.includes(`${deviceId}:${id}`) ? current.filter(value => value !== `${deviceId}:${id}`) : [...current, `${deviceId}:${id}`])}
    createProject={() => { setProjectDeviceId(deviceId); setDrawerOpen(false); }} projectActions={project => { setActionProject({ ...project, deviceId }); setDrawerOpen(false); }} threadActions={item => { setDrawerOpen(false); setNewName(item.title); setActionThread({ id: item.id, title: item.title }); }}
    updateAvailable={clientUpdates.available} close={() => setDrawerOpen(false)} settings={() => { setDrawerOpen(false); openMenu('settings'); }} refresh={() => void relay.refreshDevices()} />;

  if (restoring) return <SafeAreaView style={[s.safe, s.center]}><ActivityIndicator color={c.accent} /></SafeAreaView>;
  if (view.phase === 'locked') return <Login connect={connect} busy={loginBusy} error={view.notice} />;
  const emptyComposer = !draft.trim() && !images.length && !files.length;
  const stopMode = thread?.status === 'active' && emptyComposer;
  const continueMode = canContinue && emptyComposer;
  const submitDisabled = !ready || busy || (!!composerDraft.preparedPlan && thread?.status !== 'idle') || (emptyComposer && !continueMode && !stopMode) || (thread?.status === 'active' && !thread.activeTurnId) || images.some(image => image.loading || !!image.error) || files.some(file => file.loading || !!file.error || !file.id);
  const settings = thread?.settings ?? summary?.settings;
  return <View style={s.safe}><StatusBar style={theme.dark ? "light" : "dark"} />
    <RequestDraftProvider scope={draftScope} deviceId={deviceId} threadId={threadId} requests={view.phase === 'connected' && device?.online && !view.syncing[deviceId] ? thread?.requests : undefined}><PlanPreparationContext.Provider value={plan => { preparePlan(plan); }}><FileViewerProvider deviceId={deviceId} threadId={threadId}><PreviewContext.Provider value={{deviceId, threadId}}><ProjectBrowseContext.Provider value={project?()=>setBrowserProject({deviceId,id:project.id,open:true}):undefined}><ConversationDrawer wide={wide} open={drawerOpen} onOpenChange={setDrawerOpen} directory={directory}>
    <SafeAreaView style={s.page} edges={['top', 'left', 'right', 'bottom']}>
    <KeyboardAvoidingView style={s.page} behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}>
      <ConversationControls key={`controls:${draftScope}:${deviceId}:${threadId}`} text={draft} onChangeText={setDraft}
        preparedPlan={composerDraft.preparedPlan?.title} onRemovePreparedPlan={removePreparedPlan}
        phase={thread?.status === 'active' ? 'running' : canContinue ? 'interrupted' : turns.length ? 'completed' : 'idle'}
        busy={busy} ready={ready} submitDisabled={submitDisabled} settings={settings} options={catalog?.models ?? []}
        modelEnabled={activeSettingsEnabled && !!thread?.settings?.model && !!snapshot?.runtime.capabilities.modelUpdate}
        effortEnabled={activeSettingsEnabled && !!thread?.settings?.model && !!snapshot?.runtime.capabilities.effortUpdate}
        permissionsEnabled={activeSettingsEnabled && !!thread?.settings?.permissions && !!snapshot?.runtime.capabilities.permissionsUpdate}
        modeEnabled={ready && thread?.status === 'idle' && !!snapshot?.runtime.capabilities.collaborationModeUpdate}
        onModel={changeModel} onEffort={changeEffort} onPermission={mode => thread?.settings?.permissions ? send({type: 'thread.permissions.update', threadId, mode, expectedPermissions: thread.settings.permissions.fingerprint}) : Promise.resolve(false)}
        onMode={changeMode} onSubmit={submit} attachments={[
          ...images.map(image => ({ id: `image:${image.key}`, name: image.name, uri: image.uri, loading: image.loading, error: image.error, uploaded: !!image.id })),
          ...files.map(file => ({ id: `file:${file.key}`, name: file.asset.name, detail: file.asset.size < 1024 * 1024 ? `${Math.ceil(file.asset.size / 1024)} KB` : `${(file.asset.size / 1024 / 1024).toFixed(1)} MB`, loading: file.loading, error: file.error, uploaded: !!file.id })),
        ]}
        onRemoveAttachment={id => { const file = files.find(item => `file:${item.key}` === id); if (file) removeFile(file); else setImages(current => current.filter(item => `image:${item.key}` !== id)); }}
        onRetryAttachment={id => { const file = files.find(item => `file:${item.key}` === id), image = images.find(item => `image:${item.key}` === id); if (file) void uploadFile(file); else if (image) void uploadDraft(image, deviceId, threadId); }}
        onAttachmentPress={item => { const index = images.findIndex(image => `image:${image.key}` === item.id); if (index >= 0) openDraftImage(index); else relay.showNotice('文件已附加，可移除或发送后在会话中查看。'); }}
        onMedia={() => void pickPhotosAndVideos()} onCamera={() => void pickCamera()} onFilesPick={() => void pickFiles()}
        imageLimit={imageLimit} videoLimitMB={videoLimit / 1024 / 1024} filesSupported={!!snapshot?.runtime.capabilities.attachments}
        onImages={addImages} imageSlots={Math.max(0, imageLimit - images.length)} onFiles={addFiles}
        filesEnabled={ready && !busy && !!snapshot?.runtime.capabilities.attachments && files.length < MAX_ATTACHMENTS}
        imagesEnabled={ready && !busy && !!snapshot?.runtime.capabilities.images && images.length < imageLimit} onImageError={message => relay.showNotice(message)}>
      <DrawerSwipeArea>
      <ConversationHeader title={summary?.title ?? thread?.title ?? 'Codexer'} subtitle={`${project?.name ?? device?.name ?? '选择设备'}${threadId ? ` · ${thread?.status === 'active' ? '进行中' : thread?.status === 'idle' ? '空闲' : '接入中'}` : ''}`}
        threadUsage={chatUsage}
        running={thread?.status === 'active'}
        managementDisabled={managing || !device?.online || view.phase !== 'connected' || !!view.syncing[deviceId]}
        onRename={() => { setActionThread({ id: threadId, title: summary?.title ?? thread?.title ?? '' }); setNewName(summary?.title ?? thread?.title ?? ''); setRenaming(true); }}
        onArchive={() => { void manageThread({ type: 'thread.archive', threadId }); }}
        onDelete={() => { const title = summary?.title ?? thread?.title ?? threadId; void confirmAction('删除会话', `这将永久删除“${title}”，删除后无法恢复。确定删除吗？`).then(confirmed => { if (confirmed) void manageThread({ type: 'thread.delete', threadId }); }); }}
        deviceId={deviceId} threadId={threadId} agents={conversationSubAgents(thread, turns)} supported={!!snapshot?.runtime.capabilities.subAgents}
        synchronized={view.phase === 'connected' && !!device?.online && !!snapshot?.runtime.connected && !!thread?.ownerAvailable && !view.syncing[deviceId]}
        truncated={!!thread?.subAgentsTruncated} hasTruncatedContent={hasTruncatedContent} onDrawer={wide ? undefined : () => setDrawerOpen(true)}
        onRefresh={() => { void relay.loadHistory(deviceId, threadId).catch(() => relay.showNotice('会话刷新失败，请重试。')); relay.watchThread(deviceId, threadId, true); }}
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
        renderItem={({ item }) => <TurnView turn={item} steps={thread?.turns.find(turn => turn.id === item.id)?.plan} active={item.id === thread?.activeTurnId && thread?.status === 'active'} deviceId={deviceId} threadId={threadId} onImage={openImage} questionRequestIds={questionRequestIds} />}
        ListHeaderComponent={history?.nextCursor ? <Pressable accessibilityRole="button" accessibilityLabel="加载更早消息" disabled={history.loading} onPress={loadEarlier} style={s.earlier}>{history.loading ? <ActivityIndicator size="small" color={c.accent} /> : <Text style={s.earlierText}>{Platform.OS === 'web' ? '加载更早消息' : '下拉加载更早消息'}</Text>}</Pressable> : null}
        ListEmptyComponent={thread?.requests.length ? null : <View style={s.chatEmpty}><Terminal size={30} color={c.accent} /><Text style={s.chatEmptyTitle}>{threadId ? history?.loading ? '正在读取会话' : '开始对话' : view.devices.length ? '选择 PC Agent 和会话' : '等待 PC Agent 登录'}</Text><Text style={s.chatEmptySub}>{threadId ? '消息将在这里显示' : view.devices.length ? '从左侧选择要控制的 PC Agent' : '在 PC 上使用同一账号登录，即可在这里选择控制端'}</Text></View>}
        ListFooterComponent={<View>{!!history?.error && <Text style={s.error}>{history.error}</Text>}{thread?.requests.map(request => <DrawerSwipeBlock key={request.id}><RequestPanel request={request} deviceId={deviceId} threadId={threadId} enabled={ready && !busy} send={async payload => { const result = await relay.sendCommand(deviceId, payload); if (result.status !== 'succeeded') throw new Error(result.code); }} /></DrawerSwipeBlock>)}</View>} /></ConversationViewport>
      </DrawerSwipeArea>
      <View testID="composer-dock" style={[s.composerDock, wide && {maxWidth: 900, alignSelf: 'center'}]}>
        <JumpToBottom visible={showJumpToBottom} onPress={scrollToBottom}/>
        {!!changedTurn?.fileChanges?.length && <FileChangesPanel key={`${deviceId}:${threadId}:${changedTurn.id}`} changes={changedTurn.fileChanges} deviceId={deviceId} threadId={threadId} turnId={changedTurn.id} />}
        <View style={[wide && s.desktopContent, { paddingHorizontal: 18 }]}>
          <QueuedMessages items={thread?.queuedMessages ?? []} enabled={ready && !busy} canSteer={!!thread?.activeTurnId}
            onSteer={queueId => { if (thread?.activeTurnId) void send({ type: 'turn.queue.steer', threadId, turnId: thread.activeTurnId, queueId }); }}
            onRemove={queueId => void send({ type: 'turn.queue.remove', threadId, queueId })} onEdit={setEditingQueueId} />
          {!!view.notice && <Text accessibilityLiveRegion="polite" style={s.notice} numberOfLines={3}>{view.notice}</Text>}
          {!ready && <Text style={s.hint}>{!threadId ? '请选择会话' : view.phase === 'reconnecting' ? '正在重连服务器' : view.phase === 'connecting' ? '正在连接服务器' : !device?.online ? '设备离线，草稿已保留' : view.syncing[deviceId] ? '同步中' : '正在接入会话'}</Text>}
        </View>
      </View>
      </ConversationControls>
    </KeyboardAvoidingView>
    </SafeAreaView>
    </ConversationDrawer></ProjectBrowseContext.Provider></PreviewContext.Provider></FileViewerProvider></PlanPreparationContext.Provider></RequestDraftProvider>
    {browserProject && view.catalogs[browserProject.deviceId]?.projects.find(p=>p.id===browserProject.id) && <ProjectBrowser key={JSON.stringify([view.url,view.userId,browserProject.deviceId,browserProject.id])} open={browserProject.open} onClose={()=>setBrowserProject(old=>old?{...old,open:false}:undefined)} deviceId={browserProject.deviceId} project={view.catalogs[browserProject.deviceId]!.projects.find(p=>p.id===browserProject.id)!} online={!!view.devices.find(d=>d.id===browserProject.deviceId)?.online} supported={view.snapshots[browserProject.deviceId]?.runtime.capabilities.projectFiles===true} />}
    {editingQueueId && <QueueEditor key={`${deviceId}:${threadId}:${editingQueueId}`} deviceId={deviceId} threadId={threadId} queueId={editingQueueId} onClose={() => setEditingQueueId(null)} />}
    {!!projectDeviceId && <ProjectCreate key={projectDeviceId} catalog={view.catalogs[projectDeviceId]} online={!!view.devices.find(item => item.id === projectDeviceId)?.online} create={createProject} close={() => setProjectDeviceId('')} />}
    {actionProject && <ProjectActions key={`${actionProject.deviceId}:${actionProject.id}`} projectId={actionProject.id} name={actionProject.name} catalog={view.catalogs[actionProject.deviceId]} online={!!view.devices.find(device => device.id === actionProject.deviceId)?.online} browseFiles={()=>{setBrowserProject({deviceId:actionProject.deviceId,id:actionProject.id,open:true});setActionProject(null);}} close={() => setActionProject(null)} createThread={() => { setActionProject(null); void createThread(actionProject.id, actionProject.deviceId); }} send={async payload => {
      const target = actionProject.deviceId;
      const fresh = relay.getSnapshot().catalogs[target];
      if (!fresh?.projects.some(project => project.id === payload.projectId)) throw new Error('project-not-in-catalog');
      if (fresh.threads.some(thread => thread.projectId === payload.projectId)) throw new Error('project-not-empty');
      setManaging(true);
      try {
        const result = await relay.sendCommand(target, payload);
        if (payload.type === 'project.delete' && result.status === 'succeeded') {
          setExpandedProjects(current => current.filter(value => value !== `${target}:${payload.projectId}`));
          void relay.loadCatalog(target).catch(() => relay.showNotice('项目已删除，列表刷新失败，请重试刷新。'));
        }
        return result;
      } finally { setManaging(false); }
    }} />}
    <Dialog open={!!actionThread} title={renaming ? '重命名会话' : actionThread?.title ?? '会话操作'} busy={managing} onClose={() => { setActionThread(null); setRenaming(false); }}>
          {renaming ? <><TextInput accessibilityLabel="会话名称" style={s.field} value={newName} onChangeText={setNewName} autoFocus maxLength={1000} /><Pressable accessibilityRole="button" accessibilityLabel="保存会话名称" style={[s.primary, (!newName.trim() || managing) && s.disabled]} disabled={!newName.trim() || managing} onPress={() => actionThread && void manageThread({ type: 'thread.rename', threadId: actionThread.id, name: newName.trim() })}><Text style={s.primaryText}>保存</Text></Pressable></> : <>
            {actionThread && <ConversationId key={actionThread.id} threadId={actionThread.id} />}
            <Pressable style={s.menuOption} disabled={managing} onPress={() => setRenaming(true)}><Pencil size={18} color={c.text} /><Text style={s.menuText}>重命名</Text></Pressable>
            <Pressable style={s.menuOption} disabled={managing} onPress={() => actionThread && void manageThread({ type: 'thread.archive', threadId: actionThread.id })}><Archive size={18} color={c.text} /><Text style={s.menuText}>归档</Text></Pressable>
            <Pressable style={s.menuOption} disabled={managing} onPress={() => { const target = actionThread; if (target) void confirmAction('永久删除会话', `删除“${target.title}”后无法恢复。`).then(confirmed => { if (confirmed) void manageThread({ type: 'thread.delete', threadId: target.id }); }); }}><Trash2 size={18} color={c.danger} /><Text style={s.dangerText}>永久删除</Text></Pressable>
          </>}
    </Dialog>
    <SettingsShell open={menuOpen&&menu==='settings'} onClose={closeMenu} onWeixin={()=>setMenu('weixin')} updateAvailable={clientUpdates.available}>{section=><ControlSettings section={section} url={view.url} device={device&&{id:device.id,name:device.name,online:device.online,platform:device.platform,agentVersion:snapshot?.agentVersion??device.agentVersion,runtimeRefresh:snapshot?.runtime.capabilities.runtimeRefresh===true}} onWeixin={()=>setMenu('weixin')} onLogout={()=>{closeMenu();void relay.logout().catch(()=>{});}}/>}</SettingsShell>
    <Dialog open={menuOpen && menu === 'weixin'} title="微信设置" onClose={closeMenu}>{menuOpen && menu === 'weixin' && <WeixinSettings />}</Dialog>
    <ImageViewer preview={preview} onClose={() => setPreview(null)} onNavigate={moveImage} />
  </View>;
}

export default function App() { return <ThemeProvider><SafeAreaProvider><AppContent /></SafeAreaProvider></ThemeProvider>; }
