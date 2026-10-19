import { useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check, FolderPlus, X } from 'lucide-react-native';
import type { DeviceCatalog, RemoteCommand } from '../../../packages/protocol/src/index';
import { projectCreationError, validProjectPath } from '../../../packages/client-shared/src/project-creation';
import { useTheme } from './styles';

type Payload = Extract<RemoteCommand['payload'], { type: 'project.create' }>;
export function ProjectCreate({ catalog, online, create, close }: { catalog?: DeviceCatalog; online: boolean; create: (payload: Payload) => Promise<void>; close: () => void }) {
  const { c, s } = useTheme();
  const parents = catalog?.projectCreation?.parents ?? [];
  const [parentId, setParentId] = useState(parents[0]?.id ?? '');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState(''), [path, setPath] = useState(''), [pathEdited, setPathEdited] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const parent = parents.find(item => item.id === parentId);
  const valid = online && !!parent && !!name.trim() && validProjectPath(path);
  const submit = async () => {
    if (pending.current || !valid) return;
    pending.current = true; setBusy(true); setError('');
    try { await create({ type: 'project.create', parentId, name: name.trim(), relativePath: path, mode }); }
    catch (error) { setError(projectCreationError(error instanceof Error ? error.message : String(error))); }
    finally { pending.current = false; setBusy(false); }
  };
  const dismiss = () => { if (!pending.current) close(); };
  return <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
    <SafeAreaView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: 16 }}>
        <View style={{ backgroundColor: c.surface, borderRadius: 18, padding: 20, maxWidth: 520, width: '100%', maxHeight: '100%', alignSelf: 'center' }}>
          <View style={s.modalHeader}><Text style={s.modalTitle}>新建项目</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭新建项目" disabled={busy} onPress={dismiss} style={s.iconButton}><X size={20} color={c.text}/></Pressable></View>
          <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 4 }}>
            {!online ? <Text style={s.error}>电脑已离线，请连接后再试。</Text> : !catalog ? <Text style={s.sub}>正在读取电脑的目录权限，请稍候。</Text> : !catalog.projectCreation ? <Text style={s.sub}>请更新电脑连接器，并使用自动或 App Server 运行方式。</Text> : !parents.length ? <Text style={s.sub}>先在这台电脑的 Codexer「设置 → 新建项目的目录权限」添加父目录，保存并重新连接。</Text> : <>
              <Text style={s.label}>位置 · 电脑端已授权的父目录</Text>
              {parents.map(item => <Pressable accessibilityRole="button" accessibilityLabel={`选择父目录 ${item.path}`} accessibilityState={{ selected: item.id === parentId }} key={item.id} disabled={busy} style={s.menuOption} onPress={() => { setParentId(item.id); setError(''); }}><Text style={[s.menuText, { flex: 1 }]}>{item.path}</Text>{item.id === parentId && <Check size={18} color={c.accent}/>}</Pressable>)}
              <View style={{ flexDirection: 'row', gap: 8, marginVertical: 12 }}>{([{ id: 'new', label: '新建文件夹' }, { id: 'existing', label: '添加已有文件夹' }] as const).map(item => <Pressable accessibilityRole="button" accessibilityState={{ selected: mode === item.id }} key={item.id} disabled={busy} onPress={() => { setMode(item.id); setError(''); }} style={[s.menuOption, { flex: 1 }, mode === item.id && { backgroundColor: c.soft, borderRadius: 8 }]}><Text style={s.menuText}>{item.label}</Text></Pressable>)}</View>
              <Text style={s.label}>项目名称</Text><TextInput accessibilityLabel="项目名称" style={s.field} value={name} editable={!busy} maxLength={100} onChangeText={value => { setError(''); setName(value); if (!pathEdited) setPath(value.trim()); }} placeholder="我的项目" placeholderTextColor={c.muted}/>
              <Text style={s.label}>文件夹相对路径</Text><TextInput accessibilityLabel="文件夹相对路径" style={s.field} value={path} editable={!busy} maxLength={1024} onChangeText={value => { setError(''); setPathEdited(true); setPath(value); }} autoCapitalize="none" autoCorrect={false} placeholder="demo 或 apps/demo" placeholderTextColor={c.muted}/>
              {!!path && !validProjectPath(path) && <Text style={s.error}>{projectCreationError('project-path-invalid')}</Text>}
              <Text style={s.sub}>{mode === 'new' ? '只创建最后一级文件夹，上级子目录须已存在。' : '添加已有文件夹，不修改其中的文件。'}</Text>
              {parent && !!path && validProjectPath(path) && <Text style={[s.sub, { marginTop: 8 }]}>位置：{parent.path.replace(/[\\/]$/, '')}/{path}</Text>}
            </>}
            {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
          </ScrollView>
          <Pressable accessibilityRole="button" disabled={!valid || busy} onPress={() => void submit()} style={[s.primary, { marginTop: 16, flexDirection: 'row', gap: 8 }, (!valid || busy) && s.disabled]}>{busy ? <ActivityIndicator color={c.onAccent}/> : <><FolderPlus size={18} color={c.onAccent}/><Text style={s.primaryText}>{mode === 'new' ? '创建项目' : '添加项目'}</Text></>}</Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
