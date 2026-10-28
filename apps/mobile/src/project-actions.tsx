import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Check, Copy, SquarePen, Trash2 } from 'lucide-react-native';
import { projectDeletionPlanSchema } from '../../../packages/protocol/src/index';
import type { CommandResult, DeviceCatalog, ProjectDeletionPlan, RemoteCommand } from '../../../packages/protocol/src/index';
import { projectDeletionError } from '../../../packages/client-shared/src/project-deletion';
import { Dialog } from './dialog';
import { useTheme } from './styles';
import { copyText } from './runtime';

type Payload = Extract<RemoteCommand['payload'], { type: 'project.delete.prepare' | 'project.delete' }>;
export function ProjectActions({ projectId, name, catalog, online, send, createThread, close }: {
  projectId: string; name: string; catalog?: DeviceCatalog; online: boolean;
  send: (payload: Payload) => Promise<CommandResult>; createThread: () => void; close: () => void;
}) {
  const { c, s } = useTheme();
  const [stage, setStage] = useState<'menu' | 'choose' | 'directory' | 'done'>('menu');
  const [plan, setPlan] = useState<ProjectDeletionPlan | null>(null);
  const [remainingPaths, setRemainingPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [copiedPath, setCopiedPath] = useState(''), [copyError, setCopyError] = useState('');
  const pending = useRef(false);
  const count = catalog?.threads.filter(thread => thread.projectId === projectId).length ?? 0;
  const project = catalog?.projects.find(project => project.id === projectId);
  const roots = [...new Set(project?.roots.filter(path => path.trim()) ?? [])];
  const exists = !!project;
  const canDelete = online && exists && !!catalog?.projectDeletion && count === 0 && !busy;
  const copyPath = async (path: string) => {
    setCopiedPath(''); setCopyError('');
    try { await copyText(path); setCopiedPath(path); }
    catch { setCopyError('复制失败，请长按或选择项目路径手动复制。'); }
  };
  const run = async (deleteDirectory?: boolean) => {
    if (pending.current || !canDelete || deleteDirectory !== undefined && !plan) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await send(deleteDirectory === undefined ? { type: 'project.delete.prepare', projectId } : { type: 'project.delete', projectId, token: plan!.token, deleteDirectory });
      if (result.status !== 'succeeded') throw new Error(result.code);
      if (deleteDirectory === undefined) {
        const next = projectDeletionPlanSchema.parse(result.result);
        if (next.projectId !== projectId) throw new Error('project-deletion-stale');
        setPlan(next); setStage('choose');
      } else if (deleteDirectory && result.result?.directoryDeleted !== true) {
        const paths = result.result?.remainingDirectories;
        setRemainingPaths(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string').slice(0, 20) : plan?.roots ?? []);
        setError(projectDeletionError('project-directory-delete-failed')); setStage('done');
      } else close();
    } catch (error) {
      setError(projectDeletionError(error instanceof Error ? error.message : String(error)));
      setPlan(null); setStage('menu');
    } finally { pending.current = false; setBusy(false); }
  };
  const option = (label: string, action: () => void, disabled = false, danger = false) => <Pressable accessibilityRole="button" disabled={disabled || busy} onPress={action} style={[s.menuOption, (disabled || busy) && s.disabled]}><Text style={danger ? s.dangerText : s.menuText}>{label}</Text></Pressable>;
  return <Dialog title={stage === 'directory' ? '再次确认删除目录' : stage === 'choose' ? '删除项目' : stage === 'done' ? '项目已删除' : name} busy={busy} onClose={close}>
    {stage === 'menu' ? <>
      <View style={{ gap: 6 }}>
        <Text style={s.sub}>项目路径</Text>
        {roots.length ? roots.map(path => <View key={path} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text selectable style={[s.menuText, { minWidth: 0, lineHeight: 21 }]}>{path}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`复制项目路径 ${path}`} onPress={() => void copyPath(path)} style={{ minHeight: 40, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            {copiedPath === path ? <Check size={15} color={c.accent}/> : <Copy size={15} color={c.accent}/>}<Text style={{ fontSize: 13, color: c.accent }}>{copiedPath === path ? '已复制' : '复制'}</Text>
          </Pressable>
        </View>) : <Text style={s.sub}>暂无项目路径</Text>}
        {!!copyError && <Text accessibilityRole="alert" style={s.error}>{copyError}</Text>}
      </View>
      <Pressable accessibilityRole="button" disabled={busy || !online || !exists} onPress={createThread} style={[s.menuOption, (busy || !online || !exists) && s.disabled]}><SquarePen size={18} color={c.text}/><Text style={s.menuText}>新建会话</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={!canDelete} onPress={() => void run()} style={[s.menuOption, !canDelete && s.disabled]}><Trash2 size={18} color={c.danger}/><Text style={s.dangerText}>删除项目</Text></Pressable>
      <Text style={s.sub}>{count ? `项目中有 ${count} 个会话（含归档），仅空项目可删除。` : '只有会话数为 0 的项目可以删除。'}</Text>
      {!online ? <Text style={s.sub}>电脑已离线，请连接后再操作。</Text> : !catalog?.projectDeletion && <Text style={s.sub}>请更新此电脑的 Codexer Agent 以启用项目删除。</Text>}
    </> : stage === 'done' ? <>
      {!!remainingPaths.length && <Text style={s.sub}>请在电脑上检查以下位置的剩余文件：</Text>}
      {remainingPaths.map(path => <Text selectable key={path} style={s.sub}>{path}</Text>)}
      {option('完成', close)}
    </> : <>
      <Text style={s.menuText}>{stage === 'directory' ? `确定永久删除“${plan?.name}”及以下目录中的所有文件吗？此操作无法恢复。` : `删除空项目“${plan?.name}”，是否连同电脑上的项目目录一起删除？`}</Text>
      <View style={{ gap: 6 }}>{plan?.roots.map(path => <Text selectable key={path} style={s.sub}>{path}</Text>)}</View>
      {stage === 'choose' ? <>
        {option('删除项目，保留目录', () => void run(false), !canDelete, true)}
        {option('连同目录一起删除…', () => { setStage('directory'); setError(''); }, !canDelete || !plan?.directoryDeletion, true)}
        {plan && !plan.directoryDeletion && <Text style={s.sub}>{projectDeletionError(plan.directoryReason ?? 'project-directory-unsafe')}</Text>}
        {option('取消', close)}
      </> : <>
        {option('永久删除项目和目录', () => void run(true), !canDelete || !plan?.directoryDeletion, true)}
        {option('返回', () => setStage('choose'))}
      </>}
      {!canDelete && !busy && <Text style={s.sub}>{count ? projectDeletionError('project-not-empty') : !online ? projectDeletionError('device-offline') : '项目状态已变化，请刷新列表后重试。'}</Text>}
    </>}
    {busy && <ActivityIndicator accessibilityLabel="正在核验或删除项目" color={c.muted}/>}
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
  </Dialog>;
}
