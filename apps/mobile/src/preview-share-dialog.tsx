import {useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Modal,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import {X} from 'lucide-react-native';
import type {PreviewReference} from '../../../packages/client-shared/src/previews';
import {relay,type PreviewShare} from './relay';
import {confirmAction,copyText} from './runtime';
import {fileError} from './file-transfer';
import {themedStyles} from './theme';
import {useTheme} from './styles';

export function PreviewShareDialog({reference,deviceId,threadId,onClose}:{reference:PreviewReference|{kind:'audio';source:string;title:string};deviceId:string;threadId:string;onClose:()=>void}) {
  const {c}=useTheme(),s=useStyles();
  const [share,setShare]=useState<PreviewShare|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[note,setNote]=useState('');
  const [preset,setPreset]=useState<'30'|'1440'|'custom'>('30'),[amount,setAmount]=useState('60'),[unit,setUnit]=useState(1),[clock,setClock]=useState(Date.now());
  const loadShare=(value:PreviewShare|null)=>{setShare(value);if(value){const minutes=value.durationMinutes;if(minutes===30||minutes===1440)setPreset(String(minutes) as '30'|'1440');else{const scale=minutes%1440===0?1440:minutes%60===0?60:1;setPreset('custom');setAmount(String(minutes/scale));setUnit(scale);}}};
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const live=useRef(true),pending=useRef(false);
  useEffect(()=>{live.current=true;void relay.previewShare(deviceId,threadId,reference.kind,reference.source).then(value=>{if(live.current)loadShare(value);}).catch(value=>{if(live.current)setError(fileError(value));}).finally(()=>{if(live.current)setBusy(false);});return()=>{live.current=false;};},[deviceId,threadId,reference.kind,reference.source]);
  const run=async(action:()=>Promise<void>)=>{if(busy||pending.current)return;pending.current=true;setBusy(true);setError('');setNote('');try{await action();}catch(value){if(live.current)setError(fileError(value));}finally{pending.current=false;if(live.current)setBusy(false);}};
  const create=(rotate=false)=>void run(async()=>{
    const minutes=preset==='custom'?Number(amount)*unit:Number(preset);
    if((preset==='custom'&&!/^\d+$/.test(amount.trim()))||!Number.isSafeInteger(minutes)||minutes<1||minutes>525600)throw new Error('有效期需为 1 分钟至 365 天的整数时长');
    if(rotate&&!await confirmAction('重新生成分享链接？','旧链接将立即失效，已打开的分享也会断开。'))return;
    const value=await relay.createPreviewShare(deviceId,threadId,reference.kind,reference.source,rotate,minutes);
    if(live.current){setShare(value);setClock(Date.now());setNote('有效期已从现在开始计算');}
  });
  const expired=!!share&&share.expiresAt<=clock,active=!!share?.enabled&&!expired;
  const copy=()=>void run(async()=>{
    if(!share?.enabled||share.expiresAt<=Date.now())throw new Error('分享已停用、到期或链接已更新');
    // Start writing during this click. Waiting for a network round trip loses
    // the browser's transient clipboard activation, especially on HTTP/Safari.
    try{await copyText(share.url);}catch{throw new Error('复制失败，请长按或选择上方链接手动复制');}
    if(live.current)setNote('链接已复制');
  });
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}><View style={s.backdrop}><View accessibilityViewIsModal style={s.dialog}>
    <View style={s.header}><Text style={s.title}>{reference.kind==='audio'?'分享音频':'分享网页'}</Text><Pressable accessibilityRole="button" accessibilityLabel={reference.kind==='audio'?'关闭音频分享':'关闭网页分享'} onPress={onClose} style={s.close}><X size={20} color={c.muted}/></Pressable></View>
    <ScrollView style={s.scroll} contentContainerStyle={s.body}>
    <Text style={s.label}>{reference.title}</Text><Text style={s.muted}>持有链接的人无需登录即可访问。电脑需保持在线，{reference.kind==='server'?'网页服务需保持运行':reference.kind==='audio'?'源音频文件需保留':'源 HTML 文件需保留'}。</Text>
    <Text style={s.muted}>同一个{reference.kind==='audio'?'音频文件':'页面'}复用固定链接；有效期内，关闭预览或退出控制端不影响分享。到期后外部将无法访问。</Text>
    {reference.kind==='server'&&<Text style={s.muted}>端口分享包含该网页服务的资源和接口。</Text>}
    <Text style={s.label}>有效期</Text><View style={s.actions}>{([['30','30 分钟'],['1440','1 天'],['custom','自定义']] as const).map(([value,label])=><Pressable key={value} accessibilityRole="button" accessibilityState={{selected:preset===value}} disabled={busy} onPress={()=>setPreset(value)} style={[s.button,preset===value&&s.selected]}><Text style={s.label}>{label}</Text></Pressable>)}</View>
    {preset==='custom'&&<View style={s.custom}><TextInput accessibilityLabel="自定义有效期" value={amount} onChangeText={setAmount} editable={!busy} keyboardType="number-pad" placeholder="时长" placeholderTextColor={c.muted} style={s.input}/><View style={s.actions}>{([[1,'分钟'],[60,'小时'],[1440,'天']] as const).map(([value,label])=><Pressable key={value} accessibilityRole="button" accessibilityState={{selected:unit===value}} disabled={busy} onPress={()=>setUnit(value)} style={[s.button,unit===value&&s.selected]}><Text style={s.label}>{label}</Text></Pressable>)}</View></View>}
    <Text style={s.muted}>创建、重新开启或更新有效期时开始计时；复制链接不会延长有效期。自定义范围为 1 分钟至 365 天。</Text>
    {busy&&<ActivityIndicator color={c.accent}/>}
    {!!error&&<Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    {!!note&&<Text accessibilityRole="alert" style={s.muted}>{note}</Text>}
    {share&&<><Text style={s.label}>{expired?'分享已过期':active?'分享已开启':'分享已停用'}</Text><Text style={s.muted}>到期时间：{new Date(share.expiresAt).toLocaleString()}</Text><Text selectable style={s.address}>{share.url}</Text></>}
    <View style={s.actions}>
      {active&&share?<><Pressable accessibilityRole="button" disabled={busy} onPress={copy} style={[s.button,s.primary]}><Text style={s.primaryText}>复制链接</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>create()} style={s.button}><Text style={s.label}>更新有效期</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>create(true)} style={s.button}><Text style={s.label}>重新生成</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(async()=>{await relay.disablePreviewShare(deviceId,share.id);if(live.current)setShare({...share,enabled:false});})} style={s.button}><Text style={s.error}>停用分享</Text></Pressable></>
        :<Pressable accessibilityRole="button" disabled={busy} onPress={()=>create()} style={[s.button,s.primary]}><Text style={s.primaryText}>{share?'重新开启分享':'创建分享链接'}</Text></Pressable>}
    </View>
    </ScrollView>
  </View></View></Modal>;
}
const useStyles=themedStyles(c=>StyleSheet.create({backdrop:{flex:1,backgroundColor:'#0005',justifyContent:'center',alignItems:'center',padding:20},dialog:{width:'100%',maxWidth:560,maxHeight:'90%',borderRadius:12,padding:20,gap:16,backgroundColor:c.surface},scroll:{flexGrow:0},body:{gap:16},header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},title:{color:c.text,fontSize:18,fontWeight:'600'},close:{padding:8},label:{color:c.text,fontSize:13},muted:{color:c.muted,fontSize:13,lineHeight:21},error:{color:c.danger,fontSize:13},address:{color:c.accent,fontSize:13,padding:12,borderWidth:1,borderColor:c.line,borderRadius:8},selected:{borderColor:c.accent,backgroundColor:c.surface},custom:{gap:12},input:{borderWidth:1,borderColor:c.line,color:c.text,borderRadius:8,padding:12,fontSize:14},actions:{flexDirection:'row',flexWrap:'wrap',gap:10},button:{paddingHorizontal:16,paddingVertical:12,borderRadius:8,borderWidth:1,borderColor:c.line},primary:{backgroundColor:c.accent,borderColor:c.accent},primaryText:{color:c.onAccent,fontSize:13,fontWeight:'600'}}));
