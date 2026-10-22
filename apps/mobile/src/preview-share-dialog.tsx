import {useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Modal,Pressable,ScrollView,StyleSheet,Text,View} from 'react-native';
import {X} from 'lucide-react-native';
import type {PreviewReference} from '../../../packages/client-shared/src/previews';
import {relay,type PreviewShare} from './relay';
import {confirmAction,copyText} from './runtime';
import {fileError} from './file-transfer';
import {themedStyles} from './theme';
import {useTheme} from './styles';

export function PreviewShareDialog({reference,deviceId,threadId,onClose}:{reference:PreviewReference;deviceId:string;threadId:string;onClose:()=>void}) {
  const {c}=useTheme(),s=useStyles();
  const [share,setShare]=useState<PreviewShare|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[note,setNote]=useState('');
  const live=useRef(true),pending=useRef(false);
  useEffect(()=>{live.current=true;void relay.previewShare(deviceId,threadId,reference.kind,reference.source).then(value=>{if(live.current)setShare(value);}).catch(value=>{if(live.current)setError(fileError(value));}).finally(()=>{if(live.current)setBusy(false);});return()=>{live.current=false;};},[deviceId,threadId,reference.kind,reference.source]);
  const run=async(action:()=>Promise<void>)=>{if(busy||pending.current)return;pending.current=true;setBusy(true);setError('');setNote('');try{await action();}catch(value){if(live.current)setError(fileError(value));}finally{pending.current=false;if(live.current)setBusy(false);}};
  const create=(rotate=false)=>void run(async()=>{if(rotate&&!await confirmAction('重新生成分享链接？','旧链接将立即失效，已打开的分享也会断开。'))return;const value=await relay.createPreviewShare(deviceId,threadId,reference.kind,reference.source,rotate);if(live.current)setShare(value);});
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}><View style={s.backdrop}><View accessibilityViewIsModal style={s.dialog}>
    <View style={s.header}><Text style={s.title}>分享网页</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭网页分享" onPress={onClose} style={s.close}><X size={20} color={c.muted}/></Pressable></View>
    <ScrollView style={s.scroll} contentContainerStyle={s.body}>
    <Text style={s.label}>{reference.title}</Text><Text style={s.muted}>持有链接的人无需登录即可访问。电脑需保持在线，{reference.kind==='server'?'网页服务需保持运行':'源 HTML 文件需保留'}。</Text>
    <Text style={s.muted}>同一个页面复用固定链接；关闭预览或退出控制端后，分享仍有效。</Text>
    {reference.kind==='server'&&<Text style={s.muted}>端口分享包含该网页服务的资源和接口。</Text>}
    {busy&&<ActivityIndicator color={c.accent}/>}
    {!!error&&<Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    {!!note&&<Text accessibilityRole="alert" style={s.muted}>{note}</Text>}
    {share&&<><Text style={s.label}>{share.enabled?'分享已开启':'分享已停用'}</Text><Text selectable style={s.address}>{share.url}</Text></>}
    <View style={s.actions}>
      {share?.enabled?<><Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(async()=>{await copyText(share.url);if(live.current)setNote('链接已复制');})} style={[s.button,s.primary]}><Text style={s.primaryText}>复制链接</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>create(true)} style={s.button}><Text style={s.label}>重新生成</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(async()=>{await relay.disablePreviewShare(deviceId,share.id);if(live.current)setShare({...share,enabled:false});})} style={s.button}><Text style={s.error}>停用分享</Text></Pressable></>
        :<Pressable accessibilityRole="button" disabled={busy} onPress={()=>create()} style={[s.button,s.primary]}><Text style={s.primaryText}>{share?'重新开启分享':'创建分享链接'}</Text></Pressable>}
    </View>
    </ScrollView>
  </View></View></Modal>;
}
const useStyles=themedStyles(c=>StyleSheet.create({backdrop:{flex:1,backgroundColor:'#0005',justifyContent:'center',alignItems:'center',padding:20},dialog:{width:'100%',maxWidth:560,maxHeight:'90%',borderRadius:12,padding:20,gap:16,backgroundColor:c.surface},scroll:{flexGrow:0},body:{gap:16},header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},title:{color:c.text,fontSize:18,fontWeight:'600'},close:{padding:8},label:{color:c.text,fontSize:13},muted:{color:c.muted,fontSize:13,lineHeight:21},error:{color:c.danger,fontSize:13},address:{color:c.accent,fontSize:13,padding:12,borderWidth:1,borderColor:c.line,borderRadius:8},actions:{flexDirection:'row',flexWrap:'wrap',gap:10},button:{paddingHorizontal:16,paddingVertical:12,borderRadius:8,borderWidth:1,borderColor:c.line},primary:{backgroundColor:c.accent,borderColor:c.accent},primaryText:{color:c.onAccent,fontSize:13,fontWeight:'600'}}));
