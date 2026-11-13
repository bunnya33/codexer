import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { ArrowRight, Check, Send } from 'lucide-react-native';
import { defaultProjectTransferExclusions } from '../../../packages/protocol/src/project-transfers';
import type { ProjectTransfer, ProjectTransferCreate } from '../../../packages/protocol/src/project-transfers';
import { projectTransferError, projectTransferLabels, transferBytes, transferPreparationLabel, transferElapsed } from '../../../packages/client-shared/src/project-transfers';
import { validProjectPath } from '../../../packages/client-shared/src/project-creation';
import { Dialog } from './dialog';
import { relay } from './relay';
import { randomId } from './runtime';
import { useTheme } from './styles';

type Source = { deviceId: string; id: string; name: string };
export function ProjectTransfers({ source, close }: { source?: Source; close: () => void }) {
  const { c, s } = useTheme();
  const view = useSyncExternalStore(relay.subscribe, relay.getSnapshot);
  const [jobs, setJobs] = useState<ProjectTransfer[]>([]), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState(''), [parentId, setParentId] = useState('');
  const [relativePath, setRelativePath] = useState(source?.name.replace(/[\\/\x00-\x1f<>:"|?*]/g, '-').replace(/[. ]+$/, '').slice(0, 80) ?? '');
  const [includeGit, setIncludeGit] = useState(true), [includeLocalFiles, setIncludeLocalFiles] = useState(false);
  const [excluded, setExcluded] = useState(defaultProjectTransferExclusions.join(', ')), [note, setNote] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [clock, setClock] = useState(Date.now());
  const request = useRef<ProjectTransferCreate | null>(null), pending = useRef(false), live = useRef(true);
  const deviceName = (id: string) => view.devices.find(d => d.id === id)?.name ?? id.slice(0, 8);
  const selected = jobs.find(j => j.id === selectedId);
  const candidates = view.devices.filter(d => d.id !== source?.deviceId);
  const catalog = view.catalogs[target], parents = catalog?.projectCreation?.parents ?? [];
  const parent = parents.find(p => p.id === parentId);
  const sourceOnline = !!view.devices.find(d => d.id === source?.deviceId)?.online;
  const targetOnline = !!view.devices.find(d => d.id === target)?.online;
  const supported = !!source && !!view.catalogs[source.deviceId]?.projectTransfer && !!catalog?.projectTransfer;
  const active = !!source && jobs.some(j => j.sourceDeviceId === source.deviceId && j.projectId === source.id && !['completed', 'failed', 'cancelled'].includes(j.state));
  const excludedDirectories = excluded.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  const exclusionsValid = excludedDirectories.length <= 100 && excludedDirectories.every(name => name.length <= 100 && !/[/\\\x00-\x1f:]/.test(name) && name !== '.' && name !== '..');
  const valid = loaded && !!source && sourceOnline && targetOnline && supported && !!parent && validProjectPath(relativePath) && !relativePath.includes('/') && relativePath.length <= 100 && exclusionsValid;
  const relevant = jobs.filter(j => !source || j.sourceDeviceId === source.deviceId && j.projectId === source.id || j.targetDeviceId === source.deviceId && j.targetProjectId === source.id);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(); live.current = true;
    const refresh = async () => {
      try { const value = await relay.projectTransfers(controller.signal); if (!disposed) {setJobs(value); setLoaded(true);} }
      catch (e) { if (!disposed) {setError(projectTransferError(e instanceof Error ? e.message : String(e))); setLoaded(true);} }
      finally {if (!disposed) {setClock(Date.now()); timer = setTimeout(() => void refresh(), 5000);}}
    };
    void refresh();
    return () => {disposed = true; live.current = false; controller.abort(); if (timer) clearTimeout(timer);};
  }, []);
  const run = async (operation: () => Promise<ProjectTransfer>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await operation();
      request.current = null;
      if (live.current) {setJobs(old => [result, ...old.filter(j => j.id !== result.id)]); setSelectedId(result.id);}
    } catch (e) { if (live.current) setError(projectTransferError(e instanceof Error ? e.message : String(e))); }
    finally {pending.current = false; if (live.current) setBusy(false);}
  };
  const prepare = () => {
    if (!valid || !source || active) return;
    const value = {sourceDeviceId: source.deviceId, projectId: source.id, targetDeviceId: target, parentId, relativePath,
      options: {includeGit, includeLocalFiles, excludedDirectories, note}};
    // Retry an ambiguous HTTP outcome with the same id and identical options.
    if (!request.current || JSON.stringify({...request.current, id: undefined}) !== JSON.stringify(value)) request.current = {id: randomId(), ...value};
    void run(() => relay.prepareProjectTransfer(request.current!));
  };
  const button = (label: string, action: () => void, disabled = false, primary = false) => <Pressable accessibilityRole="button" disabled={disabled || busy} onPress={action} style={[primary ? s.primary : s.menuOption, (disabled || busy) && s.disabled]}><Text style={primary ? s.primaryText : s.menuText}>{label}</Text></Pressable>;
  const renderJob = (job: ProjectTransfer) => {
    const sending = job.state === 'uploading', receiving = job.state === 'downloading';
    const progress = job.size > 0 ? (sending ? job.uploaded : job.downloaded) / job.size : 0;
    const prep = job.preparation, sourceConnected = !!view.devices.find(d => d.id === job.sourceDeviceId)?.online;
    const preparingLabel = !sourceConnected ? '等待发送端重新连接' : transferPreparationLabel(job);
    return <View key={job.id} style={{gap: 8, padding: 12, borderWidth: 1, borderColor: c.line, borderRadius: 12}}>
      <Text style={s.menuText}>{job.name}</Text>
      <View style={{flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}><Text style={s.sub}>{deviceName(job.sourceDeviceId)}</Text><ArrowRight size={14} color={c.muted}/><Text style={s.sub}>{deviceName(job.targetDeviceId)}</Text></View>
      <Text accessibilityLiveRegion="polite" style={s.menuText}>{job.state === 'preparing' ? preparingLabel : projectTransferLabels[job.state]}</Text>
      {job.state === 'preparing' && <>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}><ActivityIndicator color={c.muted}/><Text style={s.sub}>发送端：{deviceName(job.sourceDeviceId)} · 已用时 {transferElapsed(clock - job.createdAt)}</Text></View>
        <Text style={s.sub}>接收端 {deviceName(job.targetDeviceId)} 此时无需空闲。快照就绪后还需你确认发送。</Text>
        {!sourceConnected ? <Text style={s.sub}>发送端重新连接后会自动继续。</Text> : !prep ? <>
          <Text style={s.sub}>发送端尚未报告是在等待还是正在打包，暂时无法判断具体阶段。</Text>
          <Text style={s.sub}>旧版 Agent 会等待发送电脑的所有会话空闲。更新发送端 Agent 后，可按项目等待并查看具体进度。</Text>
        </> : prep.phase === 'waiting' ? <>
          {prep.blockers.map(blocker => <Text key={blocker.id} style={s.menuText}>{blocker.title || `会话 ${blocker.id.slice(0, 8)}`} · {({running: '任务运行中', approval: '等待确认或回答', subagent: '子 Agent 运行中'})[blocker.reason]}</Text>)}
          <Text style={s.sub}>{prep.reason === 'runtime-refresh' ? '发送端正在刷新运行时，完成后自动继续。' : prep.reason === 'agent-busy' ? '发送端正在处理其他项目传输，完成后自动继续。' : '该项目及共用目录的会话没有运行任务、待处理确认或运行中的子 Agent 后，自动开始快照。其他项目不影响，每 5 秒检查一次。'}</Text>
        </> : <>
          <Text style={s.sub}>{prep.phase === 'scanning' ? `已发现 ${prep.files.toLocaleString()} 个文件、${prep.directories.toLocaleString()} 个目录 · ${transferBytes(prep.totalBytes)}` : prep.phase === 'packing' ? `已打包 ${prep.processedFiles.toLocaleString()} / ${prep.files.toLocaleString()} 个文件 · ${transferBytes(prep.processedBytes)} / ${transferBytes(prep.totalBytes)}` : prep.phase === 'verifying' ? `已复核 ${prep.processedFiles.toLocaleString()} / ${prep.files.toLocaleString()} 个文件` : `正在校验 ${transferBytes(prep.totalBytes)} 的快照，请等待校验完成。`}</Text>
          {prep.phase === 'packing' && prep.totalBytes > 0 && <View accessibilityLabel="快照打包进度" accessibilityRole="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(prep.processedBytes / prep.totalBytes * 100)} style={{height: 5, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden'}}><View style={{height: 5, width: `${Math.min(100, prep.processedBytes / prep.totalBytes * 100)}%`, backgroundColor: c.accent}}/></View>}
        </>}
        {sourceConnected && !!prep?.updatedAt && <Text style={s.sub}>发送端 {transferElapsed(clock - prep.updatedAt)}前报告{clock - prep.updatedAt > 30000 ? '，暂未收到新的进度，正在继续查询。' : '，状态自动更新。'}</Text>}
      </>}
      {job.state === 'ready' && <>
        <Text style={s.sub}>{job.files.toLocaleString()} 个文件 · {job.directories.toLocaleString()} 个目录 · {transferBytes(job.size)}</Text>
        <Text selectable style={s.sub}>保存到：{job.parentPath.replace(/[\\/]$/, '')}/{job.relativePath}</Text>
        <Text style={s.sub}>已排除 {job.excluded.toLocaleString()} 项{job.excludedSamples.length ? `：\n${job.excludedSamples.join('\n')}` : ''}</Text>
        <Text style={s.sub}>{job.options.includeGit ? '携带项目内的本地 Git 数据。' : '跳过 Git 数据。'}{job.options.includeLocalFiles ? '携带本地环境配置和数据库。' : '跳过本地环境配置和数据库。'}</Text>
        {!!job.options.note && <Text selectable style={s.sub}>交接说明：{job.options.note}</Text>}
        {button('确认发送', () => void run(() => relay.projectTransferAction(job.id, 'start')), false, true)}
      </>}
      {(sending || receiving) && <>
        <View accessibilityRole="progressbar" accessibilityValue={{min: 0, max: 100, now: Math.round(progress * 100)}} style={{height: 5, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden'}}><View style={{height: 5, width: `${Math.max(0, Math.min(100, progress * 100))}%`, backgroundColor: c.accent}}/></View>
        <Text style={s.sub}>{transferBytes(sending ? job.uploaded : job.downloaded)} / {transferBytes(job.size)} · {Math.round(progress * 100)}%</Text>
        {(!view.devices.find(d => d.id === (sending ? job.sourceDeviceId : job.targetDeviceId))?.online) && <Text style={s.sub}>等待设备重新连接，恢复后继续传输。</Text>}
      </>}
      {(job.state === 'received' || job.state === 'completed') && <>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}><Check size={16} color={c.accent}/><Text style={s.sub}>文件已保存在目标设备</Text></View>
        <Text selectable style={s.menuText}>{job.savedPath}</Text>
        <Text style={s.sub}>{job.state === 'completed' ? '你可以随时切换到该设备，打开项目继续操作。' : '文件已接收。项目列表登记会自动重试，也可在目标设备添加此目录。'}</Text>
      </>}
      {job.state === 'failed' && <Text style={s.error}>{projectTransferError(job.code)}</Text>}
      {['preparing', 'ready', 'uploading', 'downloading'].includes(job.state) && button('取消传输', () => void run(() => relay.projectTransferAction(job.id, 'cancel')))}
    </View>;
  };
  return <Dialog title={source ? `发送项目 · ${source.name}` : '项目传输'} onClose={close}>
    <Text style={s.sub}>接收设备会先保存项目。之后由你切换设备，按需要继续操作。关闭此窗口后传输仍会继续，记录保留 24 小时。</Text>
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    {!loaded && <ActivityIndicator color={c.muted}/>}
    {source && !selected && !active && <>
      <Text style={s.menuText}>接收设备</Text>
      {candidates.map(d => <Pressable key={d.id} accessibilityRole="radio" accessibilityState={{checked: target === d.id}} onPress={() => {setTarget(d.id); setParentId(view.catalogs[d.id]?.projectCreation?.parents[0]?.id ?? '');}} style={s.menuOption}><Text style={s.menuText}>{target === d.id ? '● ' : '○ '}{d.name} · {d.online ? '在线' : '离线'}</Text></Pressable>)}
      {!candidates.length && <Text style={s.sub}>请先让另一台设备登录同一账号并连接。</Text>}
      {!!target && <>
        {!supported ? <Text style={s.sub}>两台设备均需更新支持项目传输的 Codexer Agent。</Text> : <>
          <Text style={s.menuText}>保存目录</Text>
          {parents.map(p => <Pressable key={p.id} accessibilityRole="radio" accessibilityState={{checked: parentId === p.id}} onPress={() => setParentId(p.id)} style={s.menuOption}><Text selectable style={s.menuText}>{parentId === p.id ? '● ' : '○ '}{p.path}</Text></Pressable>)}
          {!parents.length && <Text style={s.sub}>请先在接收设备的 Agent 设置中授权项目父目录。</Text>}
          <TextInput accessibilityLabel="接收项目的文件夹名称" value={relativePath} onChangeText={setRelativePath} style={s.field} placeholder="新文件夹名称" placeholderTextColor={c.muted} maxLength={100} autoCapitalize="none" autoCorrect={false}/>
          <Text style={s.sub}>使用新的文件夹名称，已有目录会保留。</Text>
          <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10}}><Text style={s.menuText}>保留本地 Git 历史</Text><Switch accessibilityLabel="保留本地 Git 历史" value={includeGit} onValueChange={setIncludeGit}/></View>
          <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10}}><Text style={s.menuText}>包含本地配置与数据库</Text><Switch accessibilityLabel="包含本地配置与数据库" value={includeLocalFiles} onValueChange={setIncludeLocalFiles}/></View>
          <Text style={s.sub}>本地配置包括 .env，数据库包括 .db、.sqlite 和 .sqlite3；示例环境配置会保留。</Text>
          <Text style={s.menuText}>排除目录名</Text>
          <TextInput accessibilityLabel="排除目录名" value={excluded} onChangeText={setExcluded} style={s.field} multiline placeholder="用逗号或换行分隔" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} maxLength={10000}/>
          {!exclusionsValid && <Text style={s.error}>请填写目录名，用逗号或换行分隔；最多 100 项，每项不超过 100 个字符。</Text>}
          <Text style={s.sub}>按目录名排除所有层级的匹配目录；可调整默认项。单次快照最多 4 GiB、100,000 个文件和目录。</Text>
          <TextInput accessibilityLabel="可选开发交接说明" value={note} onChangeText={setNote} style={[s.field, {minHeight: 90}]} multiline maxLength={20000} placeholder="可选：项目进度、运行方法、下一步任务" placeholderTextColor={c.muted}/>
          <Pressable accessibilityRole="button" disabled={!valid || busy} onPress={prepare} style={[s.primary, {flexDirection: 'row', gap: 8}, (!valid || busy) && s.disabled]}><Send size={16} color={c.onAccent}/><Text style={s.primaryText}>生成快照并预览</Text></Pressable>
        </>}
      </>}
    </>}
    {selected ? <>{renderJob(selected)}{button('返回传输列表', () => setSelectedId(''))}</> : relevant.map(renderJob)}
    {!source && loaded && !relevant.length && <Text style={s.sub}>暂无传输记录。可在项目菜单选择“发送到其他设备”。</Text>}
    {busy && <ActivityIndicator color={c.muted}/>}
  </Dialog>;
}
