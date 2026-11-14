import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Download } from 'lucide-react-native';
import { downloadCompletionNotice, mobileDownloads, openDownload, shareDownload } from './downloads-mobile';
import { relay } from './relay';
import { confirmAction } from './runtime';
import { useTheme } from './styles';
import { ReviewReader } from './review-reader';
import type { DownloadItem } from '../../../packages/client-shared/src/downloads';

export const downloadLibraryAvailable = true;
const scope = () => { const view = relay.getSnapshot(); return view.phase === 'locked' ? '' : JSON.stringify([view.url, view.userId]); };
export function DownloadLifecycle() {
  useEffect(() => {
    void downloadCompletionNotice.initialize().catch(() => {});
    let previous = scope();
    const off = relay.subscribe(() => { const next = scope(); if (previous !== next) { previous = next; void mobileDownloads.pauseAll(); } });
    const listener = AppState.addEventListener('change', phase => { if (phase !== 'active') void mobileDownloads.pauseAll(); });
    return () => { off(); listener.remove(); void mobileDownloads.pauseAll(); };
  }, []);
  return null;
}
const bytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const labels = { downloading: '正在下载', paused: '已暂停', completed: '已完成', failed: '下载失败' };

export function DownloadList() {
  const { c } = useTheme(), state = useSyncExternalStore(mobileDownloads.subscribe, mobileDownloads.getSnapshot);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'pending' | 'completed'>('all');
  const [busy, setBusy] = useState<string[]>([]), [notice, setNotice] = useState('');
  useEffect(() => { void mobileDownloads.initialize().catch(() => {}); }, []);
  const action = async (item: DownloadItem, operation: () => Promise<unknown>, blocking = true) => {
    setNotice(''); if (blocking) setBusy(value => [...value, item.id]);
    try {
      const result = await operation();
      if (result === 'permission-required') setNotice('请允许安装此来源的应用，返回后再次点「安装」。文件已保留。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败，请重试。'); }
    finally { if (blocking) setBusy(value => value.filter(id => id !== item.id)); }
  };
  const items = state.items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (item.state === 'completed') === (filter === 'completed')));
  const button = (item: DownloadItem, label: string, operation: () => Promise<unknown>, blocking = true, danger = false) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label} ${item.name}`} disabled={busy.includes(item.id)} onPress={() => void action(item, operation, blocking)} style={{ paddingVertical: 10, paddingHorizontal: 8, opacity: busy.includes(item.id) ? 0.4 : 1 }}><Text style={{ color: danger ? c.danger : c.accent, fontSize: 13 }}>{label}</Text></Pressable>;
  return <View style={{ gap: 16 }}>
    <Text style={{ color: c.muted, fontSize: 13, lineHeight: 20 }}>关闭文件面板后仍会继续下载，可在这里暂停或继续。文件保存在本机，完成后可再次打开、安装或分享。</Text>
    <TextInput accessibilityLabel="搜索下载文件" value={query} onChangeText={setQuery} placeholder="搜索文件名" placeholderTextColor={c.muted} style={{ color: c.text, backgroundColor: c.surface, borderRadius: 12, padding: 13 }} />
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: 8 }}>{([{ id: 'all', label: '全部' }, { id: 'pending', label: '未完成' }, { id: 'completed', label: '已完成' }] as const).map(option => <Pressable key={option.id} accessibilityRole="tab" accessibilityLabel={option.label} accessibilityState={{ selected: filter === option.id }} onPress={() => setFilter(option.id)} style={{ padding: 10, borderRadius: 10, backgroundColor: filter === option.id ? c.soft : undefined }}><Text style={{ color: filter === option.id ? c.accent : c.muted }}>{option.label}</Text></Pressable>)}</View>
    {!state.ready && !state.error && <ActivityIndicator color={c.accent} />}
    {!!state.error && <><Text accessibilityRole="alert" style={{ color: c.danger }}>{state.error}</Text><Pressable accessibilityRole="button" onPress={() => void mobileDownloads.initialize().catch(() => {})}><Text style={{ color: c.accent }}>重新读取下载列表</Text></Pressable></>}
    {state.ready && !items.length && <Text style={{ color: c.muted, paddingVertical: 24, textAlign: 'center' }}>{state.items.length ? '没有匹配的文件' : '暂无下载文件，会话文件和安装包下载后会出现在这里。'}</Text>}
    {items.map(item => <View key={item.id} testID={`download-${item.id}`} style={{ backgroundColor: c.surface, padding: 15, borderRadius: 15, gap: 8 }}>
      <Text selectable style={{ color: c.text, fontSize: 15, fontWeight: '600' }}>{item.name}</Text>
      <Text style={{ color: c.muted, fontSize: 12 }}>{labels[item.state]} · {bytes(item.transferred)} / {bytes(item.size)}{item.state === 'downloading' && item.size ? ` · ${Math.floor(item.transferred / item.size * 100)}%` : ''}</Text>
      <Text style={{ color: c.muted, fontSize: 12 }}>{new Date(item.createdAt).toLocaleString()}</Text>
      {item.state === 'downloading' && <View style={{ height: 4, borderRadius: 2, backgroundColor: c.soft, overflow: 'hidden' }}><View style={{ height: 4, width: `${item.size ? Math.min(100, item.transferred / item.size * 100) : 0}%`, backgroundColor: c.accent }} /></View>}
      {!!item.error && <Text accessibilityRole="alert" style={{ color: c.danger, fontSize: 12 }}>{item.error}</Text>}
      <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap', marginHorizontal: -8 }}>
        {item.state === 'completed' && <>{button(item, Platform.OS === 'android' && /\.apk$/i.test(item.name) ? '安装' : '打开', () => openDownload(item))}{button(item, '分享／保存副本', () => shareDownload(item))}</>}
        {item.state === 'downloading' ? button(item, '暂停', () => mobileDownloads.pause(item.id)) : item.remote && item.state !== 'completed' && button(item, '继续', () => mobileDownloads.start(item.id), false)}
        {item.remote && item.state !== 'downloading' && button(item, '重新下载', async () => { if (await confirmAction('重新下载', `丢弃「${item.name}」的现有文件或进度，并重新下载？`)) void action(item, () => mobileDownloads.restart(item.id), false); })}
        {button(item, '删除', async () => { if (await confirmAction('删除下载文件', `删除「${item.name}」的本地文件和下载记录？`)) await mobileDownloads.remove(item.id); }, true, true)}
      </View>
    </View>)}
    {!!notice && <Text accessibilityRole="alert" style={{ color: c.muted, fontSize: 13, lineHeight: 20 }}>{notice}</Text>}
  </View>;
}

export function DownloadLibraryButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false), { c, s } = useTheme();
  const unread = useSyncExternalStore(downloadCompletionNotice.subscribe, downloadCompletionNotice.getSnapshot);
  useEffect(() => { void downloadCompletionNotice.initialize().catch(() => {}); }, []);
  return <><Pressable accessibilityRole="button" accessibilityLabel="下载列表" onPress={() => { void downloadCompletionNotice.markRead().catch(() => {}); setOpen(true); }} style={compact ? s.iconButton : { padding: 12, flexDirection: 'row', gap: 8, alignSelf: 'center', alignItems: 'center' }}><Download size={compact ? 19 : 17} color={c.text} />{!compact && <Text style={{ color: c.muted }}>下载列表</Text>}{compact && unread && <View testID="download-unread-dot" accessibilityLabel="有新下载完成" pointerEvents="none" style={{ position: 'absolute', right: 7, top: 6, width: 8, height: 8, borderRadius: 4, backgroundColor: '#eb373a' }} />}</Pressable>
    <ReviewReader open={open} onClose={() => setOpen(false)} title="下载列表"><ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }}><DownloadList /></ScrollView></ReviewReader>
  </>;
}
