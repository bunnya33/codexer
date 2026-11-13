import { useContext, useEffect, useRef, useState } from 'react';
import type {ReactNode} from 'react';
import {ProjectBrowseContext} from './project-browser-context';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ChevronLeft, ChevronRight, Copy, Download, FileCode2, Folder, Search } from 'lucide-react-native';
import type { HistoryTurn } from '../../../packages/protocol/src/index';
import type { FileInfo } from '../../../packages/protocol/src/files';
import { MAX_FILE_PREVIEW_BYTES } from '../../../packages/protocol/src/files';
import { useTheme } from './styles';
import { ReviewReader } from './review-reader';
import { ChromeButton } from './interaction/primitives';
import { FileDiff } from './file-diff';
import { SourceCode } from './source-code';
import { relay } from './relay';
import { fileError, previewFile } from './file-transfer';
import { downloadFile } from './file-download';
import { copyText } from './runtime';
import { exportText } from './export-text';

type Changes = NonNullable<HistoryTurn['fileChanges']>;
type Source = { phase: 'loading' | 'ready' | 'error' | 'download'; path: string; info?: FileInfo; text?: string; error?: string };
export function FileChangesPanel({ changes, compact = true, deviceId = '', threadId = '', turnId, renderTrigger }: { changes: Changes; compact?: boolean; deviceId?: string; threadId?: string; turnId?: string; renderTrigger?: (openFile: (path: string) => void) => ReactNode }) {
  const { c, s } = useTheme();
  const browse=useContext(ProjectBrowseContext),pendingBrowse=useRef(false);
  const [open, setOpen] = useState(false), [path, setPath] = useState<string>(), [query, setQuery] = useState(''), [tab, setTab] = useState<'diff' | 'source'>('diff');
  const [source, setSource] = useState<Source>(), [feedback, setFeedback] = useState(''), [downloading, setDownloading] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const operation = useRef<AbortController | undefined>(undefined), downloadLock = useRef(false);
  const diffScroll = useRef<ScrollView>(null), listScroll = useRef<ScrollView>(null);
  const positions = useRef(new Map<string, {version: string; offset: number}>()), listOffset = useRef(0);
  const selected = changes.find(change => change.path === path);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (selected && tab === 'diff') { const saved = positions.current.get(`${selected.path}:diff`); diffScroll.current?.scrollTo({y: saved?.version === selected.diff ? saved.offset : 0, animated:false}); }
      else if (!selected) listScroll.current?.scrollTo({y:listOffset.current,animated:false});
    });
    return () => cancelAnimationFrame(frame);
  }, [open, path, tab, selected?.diff]);
  useEffect(() => { if (path && !selected) { setPath(undefined); setTab('diff'); } }, [path, selected]);
  useEffect(() => {
    if (!open || !selected || tab !== 'source' || !deviceId || !threadId) return;
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setSource({ path: selected.path, phase: 'loading' }); setFeedback('');
    void (async () => {
      try {
        const info = await relay.fileInfo(deviceId, threadId, selected.path, controller.signal);
        if (controller.signal.aborted) return;
        if (info.size > MAX_FILE_PREVIEW_BYTES) { setSource({ path: selected.path, info, phase: 'download', error: '文件超过 2 MiB 预览上限，请下载原文件查看。' }); return; }
        try {
          const text = await previewFile(relay.fileSource(deviceId, threadId, selected.path, info.version), info, controller.signal, false);
          if (!controller.signal.aborted) setSource({ path: selected.path, info, text, phase: 'ready' });
        } catch (failure) {
          if (fileError(failure) !== '无法按 UTF-8 文本读取，请下载后查看') throw failure;
          if (!controller.signal.aborted) setSource({ path: selected.path, info, phase: 'download', error: fileError(failure) });
        }
      } catch (failure) { if (!controller.signal.aborted) setSource({ path: selected.path, phase: 'error', error: fileError(failure) }); }
    })();
    return () => controller.abort();
  }, [open, path, tab, deviceId, threadId, loadRevision, selected?.diff]);
  useEffect(() => () => { operation.current?.abort(); }, []);
  const close = () => { operation.current?.abort(); setOpen(false); };
  const action = async (operation: () => Promise<unknown>, message: string) => { try { await operation(); setFeedback(message); } catch (failure) { setFeedback(failure instanceof Error ? fileError(failure) : '操作失败，请重试。'); } };
  const sourceReady = !!source && source.path === path && source.phase === 'ready';
  const download = async () => {
    if (!source?.info || source.path !== path || downloadLock.current) return;
    downloadLock.current = true; setDownloading(true);
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    try { await downloadFile(relay.fileSource(deviceId, threadId, source.path, source.info.version), source.info, controller.signal, progress => { if (!controller.signal.aborted) setFeedback(`正在下载… ${Math.round(progress * 100)}%`); }); if (!controller.signal.aborted) setFeedback('文件已交给系统保存。'); }
    catch (failure) { if (!controller.signal.aborted) setFeedback(fileError(failure)); }
    finally { downloadLock.current = false; setDownloading(false); }
  };
  if (!changes.length) return null;
  return <View style={renderTrigger ? undefined : compact ? s.changes : s.completedChanges}>
    {renderTrigger ? renderTrigger(file => {setPath(file); setTab('diff'); setFeedback(''); setOpen(true);}) : <Pressable accessibilityRole="button" accessibilityLabel={`${changes.length} 个文件已更改，${open ? '收起' : '查看'}差异`} aria-expanded={open} onPress={() => { setOpen(true); setPath(undefined); }} style={compact ? s.changeHead : s.completedChangeHead}>{!compact && <Folder size={15} color={c.muted} />}<Text style={compact ? s.changeTitle : s.completedChangeTitle}>{compact ? `${changes.length} 个文件已更改` : `已编辑 ${changes.length} 个文件`}</Text><Text style={s.additions}>+{changes.reduce((sum, change) => sum + change.additions, 0)}</Text><Text style={s.deletions}>-{changes.reduce((sum, change) => sum + change.deletions, 0)}</Text><ChevronRight size={15} color={c.muted} /></Pressable>}
    <ReviewReader open={open} onClose={close} title="本轮文件更改" onClosed={()=>{if(pendingBrowse.current){pendingBrowse.current=false;browse?.();}}} onBack={path ? () => { operation.current?.abort(); setPath(undefined); setTab('diff'); setFeedback(''); } : undefined}>
      {!!browse&&<Pressable accessibilityRole="button" accessibilityLabel="浏览全部项目文件" onPress={()=>{pendingBrowse.current=true;close();}} style={{padding:16}}><Text style={{color:c.accent,fontSize:13}}>本轮更改 · 浏览全部项目文件 ›</Text></Pressable>}
      <View style={{ padding: 16, gap: 8, flexShrink: 0 }}><Text style={{ color: c.muted, fontSize: 11 }}>仅本轮已观测更改{turnId ? ` · ${turnId}` : ''}，不代表整个仓库状态</Text>
      {selected ? <><View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><ChromeButton Icon={ChevronLeft} label="返回更改列表" onPress={() => { operation.current?.abort(); setPath(undefined); setTab('diff'); setFeedback(''); }} size={18} /><Text selectable style={{ color: c.text, flex: 1, fontSize: 13 }}>{selected.path}</Text></View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Pressable accessibilityRole="tab" accessibilityLabel="文件差异" aria-selected={tab === 'diff'} onPress={() => { operation.current?.abort(); setTab('diff'); setFeedback(''); }} style={{ padding: 10, borderRadius: 14, borderBottomColor:c.text,borderBottomWidth:tab==='diff'?1.5:0, backgroundColor: tab === 'diff' ? c.composer : 'transparent' }}><Text style={{ color: c.text, fontSize: 13 }}>差异</Text></Pressable><Pressable accessibilityRole="tab" accessibilityLabel="当前源码" aria-selected={tab === 'source'} disabled={!deviceId || !threadId} onPress={() => { setSource(undefined); setFeedback(''); setTab('source'); }} style={{ padding: 10, borderRadius: 14, borderBottomColor:c.text,borderBottomWidth:tab==='source'?1.5:0, backgroundColor: tab === 'source' ? c.composer : 'transparent', opacity: deviceId && threadId ? 1 : .4 }}><Text style={{ color: c.text, fontSize: 13 }}>当前源码</Text></Pressable><View style={{ flex: 1 }} />
          <ChromeButton Icon={Copy} label={tab === 'diff' ? '复制差异' : '复制源码'} size={17} disabled={tab === 'diff' ? !selected.diff || selected.truncated : !sourceReady} onPress={() => void action(() => copyText(tab === 'diff' ? selected.diff : source!.text!), '已复制')} />
          <ChromeButton Icon={Download} label={tab === 'diff' ? '导出差异' : '下载源文件'} size={17} disabled={downloading || (tab === 'diff' ? !selected.diff || selected.truncated : !source?.info || source.path !== path)} onPress={() => { if (tab === 'diff') void action(() => exportText(`${selected.path.split(/[\\/]/).at(-1)}.patch`, selected.diff, 'text/x-diff'), '已交给系统保存或分享'); else void download(); }} /></View>
        {tab === 'diff' && selected.truncated && <Text style={{ color: c.muted, fontSize: 12 }}>部分差异已截断，无法复制或导出完整补丁。</Text>}{tab === 'source' && <Text style={{ color: c.muted, fontSize: 11 }}>当前磁盘版本，可能与本轮修改时不同{source?.info && source.path === path ? ` · ${source.info.version.slice(0, 8)}` : ''}；已删除文件仍可查看保留的差异。</Text>}
      </> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.composer, borderRadius: 14, paddingHorizontal: 12 }}><Search size={16} color={c.muted} /><TextInput accessibilityLabel="筛选本轮更改文件" value={query} onChangeText={setQuery} placeholder="搜索文件名或路径" placeholderTextColor={c.muted} style={{ color: c.text, flex: 1, paddingVertical: 12, fontSize: 14 }} /></View>}
      {!!feedback && <Text accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: 12 }}>{feedback}</Text>}</View>
      {!selected ? <ScrollView ref={listScroll} onScroll={event => {listOffset.current=event.nativeEvent.contentOffset.y;}} scrollEventThrottle={64} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}>{changes.filter(change => change.path.toLowerCase().includes(query.toLowerCase())).map(change => <Pressable key={change.path} accessibilityRole="button" accessibilityLabel={`${change.path}，查看差异`} onPress={() => { setPath(change.path); setTab('diff'); setFeedback(''); setSource(undefined); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 16, borderBottomColor: c.line, borderBottomWidth: .5 }}><FileCode2 size={17} color={c.muted} /><Text style={{ color: c.text, fontSize: 13, flex: 1 }}>{change.path}</Text><Text style={s.additions}>+{change.additions}</Text><Text style={s.deletions}>-{change.deletions}</Text><ChevronRight size={14} color={c.muted} /></Pressable>)}{!changes.some(change => change.path.toLowerCase().includes(query.toLowerCase())) && <Text style={{ color: c.muted, padding: 20 }}>没有匹配的更改文件</Text>}</ScrollView>
        : tab === 'diff' ? <ScrollView ref={diffScroll} key={selected.path} onScroll={event => positions.current.set(`${selected.path}:diff`,{version:selected.diff,offset:event.nativeEvent.contentOffset.y})} scrollEventThrottle={64} testID="expanded-file-diff" contentContainerStyle={{ paddingBottom: 30 }}>{selected.diff ? <FileDiff fullHeight diff={selected.diff} path={selected.path} /> : <Text style={{ padding: 20, color: c.muted }}>差异暂不可用</Text>}</ScrollView>
        : sourceReady ? <SourceCode key={selected.path + source!.info!.version} text={source!.text!} path={selected.path} initialOffset={positions.current.get(`${selected.path}:source`)?.version === source!.info!.version ? positions.current.get(`${selected.path}:source`)!.offset : 0} onOffset={offset => positions.current.set(`${selected.path}:source`,{version:source!.info!.version,offset})} /> : <View style={{ padding: 24, gap: 16 }}>{!source || source.path !== path || source.phase === 'loading' ? <ActivityIndicator color={c.muted} /> : <><Text accessibilityRole={source.phase === 'error' ? 'alert' : undefined} style={{ color: c.muted, lineHeight: 21 }}>{source.error}</Text>{source.phase === 'error' && <Pressable accessibilityRole="button" accessibilityLabel="重试读取源码" onPress={() => { setSource(undefined); setLoadRevision(value=>value+1); }}><Text style={{ color: c.accent }}>重新读取</Text></Pressable>}</>}</View>}
    </ReviewReader>
  </View>;
}
