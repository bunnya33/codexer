import {createContext,useContext,useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {ActivityIndicator,Animated,KeyboardAvoidingView,Modal,Platform,Pressable,Share,StyleSheet,Text,TextInput,View,useWindowDimensions} from 'react-native';
import {ArrowUp,Check,Copy,GitBranch,MoreHorizontal,Pencil,TextSelect,Share2,X,Plus} from 'lucide-react-native';
import type {RemoteItem} from '../../../packages/protocol/src/index';
import {messagePlainText} from '../../../packages/client-shared/src/message-text';
import {copyText} from './runtime';
import {messageHaptic} from './haptics';
import {relay} from './relay';
import {useTheme} from './styles';
import {ComposerInput} from './composer';
import {ComposerPopover} from './composer-popover';
import {SafeAreaView,useSafeAreaInsets} from 'react-native-safe-area-context';
import {ContextMenuGroup,ContextMenuRow} from './interaction/context-menu';
import {pickAttachments} from './attachment-picker';
import {attachmentByteLimit,MAX_ATTACHMENTS} from '../../../packages/protocol/src/uploads';
import type {Attachment} from '../../../packages/protocol/src/uploads';
import {deliverMessageEdit, type EditDelivery} from './message-edit-delivery';

export const MessageTurnContext=createContext({turnId:'',time:''});
function menuTime(value:string){
  if(!value)return '';
  const date=new Date(value),now=new Date();
  if(!Number.isFinite(date.getTime()))return '';
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),day=new Date(date.getFullYear(),date.getMonth(),date.getDate());
  const prefix=day.getTime()===today.getTime()?'今天':day.getTime()===new Date(now.getFullYear(),now.getMonth(),now.getDate()-1).getTime()?'昨天':`${date.getMonth()+1}月${date.getDate()}日`;
  return `${prefix} ${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
}
type EditTarget={turnId:string;item:RemoteItem};
const Actions=createContext<{canEdit:boolean;canFork?:boolean;onForkReply?:(turnId:string)=>void;edit:(target:EditTarget)=>void;copied:()=>void;onSelection?:(active:boolean)=>void}>({canEdit:false,edit:()=>{},copied:()=>{}});

export function MessageActionsProvider({children,deviceId,threadId,canEdit,canFork,onForkReply,onFork,onSelection}:{children:ReactNode;deviceId:string;threadId:string;canEdit:boolean;canFork:boolean;onForkReply:(turnId:string)=>void;onFork:(id:string)=>void;onSelection?:(active:boolean)=>void}){
  const [target,setTarget]=useState<EditTarget|null>(null);
  const {c}=useTheme();
  const [copied,setCopied]=useState(false);
  const toastOpacity=useRef(new Animated.Value(0)).current;
  const toastTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>{clearTimeout(toastTimer.current);toastOpacity.stopAnimation();},[toastOpacity]);
  const notifyCopied=()=>{
    clearTimeout(toastTimer.current);setCopied(true);
    Animated.timing(toastOpacity,{toValue:1,duration:140,useNativeDriver:Platform.OS!=='web'}).start();
    toastTimer.current=setTimeout(()=>Animated.timing(toastOpacity,{toValue:0,duration:180,useNativeDriver:Platform.OS!=='web'}).start(({finished})=>{if(finished)setCopied(false);}),2800);
  };
  const attempts=useRef(new Map<string,EditDelivery>());
  const delivery=(key:string)=>{let value=attempts.current.get(key);if(!value){value={status:'idle'};attempts.current.set(key,value);}return value;};
  return <Actions.Provider value={{canEdit,canFork,onForkReply,edit:setTarget,copied:notifyCopied,onSelection}}><View style={{flex:1}}>{children}{copied&&<Animated.View pointerEvents="none" accessibilityLiveRegion="polite" accessibilityRole="alert" style={[styles.copyToast,{backgroundColor:c.glass,borderColor:c.faint,shadowColor:c.shadow,opacity:toastOpacity}]}><View style={[styles.toastCheck,{backgroundColor:c.muted}]}><Check size={11} strokeWidth={2.8} color={c.surface}/></View><Text style={{color:c.text,fontSize:12,fontWeight:'600'}}>消息已复制</Text></Animated.View>}</View>{target&&<MessageEditor key={JSON.stringify([deviceId,threadId,target.turnId,target.item.id])} target={target} delivery={delivery(target.item.id)} canEdit={canEdit} deviceId={deviceId} threadId={threadId} close={()=>setTarget(null)} onFork={onFork}/>}</Actions.Provider>;
}

export function ReplyMoreButton() {
  const { canFork, onForkReply } = useContext(Actions);
  const { turnId } = useContext(MessageTurnContext);
  const { c, s } = useTheme();
  const anchor = useRef<View>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!canFork) setOpen(false); }, [canFork]);
  if (!canFork || !turnId) return null;
  return <>
    <View ref={anchor} collapsable={false}>
      <Pressable accessibilityRole="button" accessibilityLabel="更多回复操作" accessibilityState={{ expanded: open }}
        style={[s.iconButton, { width: 30, height: 28 }]} onPress={() => setOpen(true)}>
        <MoreHorizontal size={16} color={c.muted} />
      </Pressable>
    </View>
    {open && <ComposerPopover anchor={anchor} open={open} width={190} align="start" onClose={() => setOpen(false)}>
      <ContextMenuGroup>
        <ContextMenuRow title="分支到新聊天" Icon={GitBranch} onPress={() => { setOpen(false); onForkReply?.(turnId); }} />
      </ContextMenuGroup>
    </ComposerPopover>}
  </>;
}

/** Native iOS exposes its system context menu; other hosts use this anchored menu. */
export function useMessageAction({item,display,deviceId,threadId}:{item:RemoteItem;display:string;deviceId:string;threadId:string}){
  const actions=useContext(Actions),turn=useContext(MessageTurnContext);
  const anchor=useRef<View>(null);
  const [copied,setCopied]=useState(false),[menu,setMenu]=useState<{x:number;y:number;width:number;height:number}|null>(null),[selecting,setSelecting]=useState(false),[selectionRequest,setSelectionRequest]=useState(0);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),mounted=useRef(true),pending=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;clearTimeout(timer.current);};},[]);
  const selection=(active:boolean)=>{setSelecting(active);if(active)actions.onSelection?.(true);};
  const copiedSuccessfully=()=>{if(mounted.current){setCopied(true);actions.copied();clearTimeout(timer.current);timer.current=setTimeout(()=>setCopied(false),1500);}};
  const copy=async()=>{
    if(pending.current)return;
    pending.current=true;
    try{await copyText(messagePlainText(display));copiedSuccessfully();}
    catch{relay.showNotice('复制失败，请选择文字手动复制');}
    finally{pending.current=false;}
  };
  const open=()=>anchor.current?.measureInWindow((x,y,width,height)=>{if(mounted.current)setMenu({x,y,width,height});});
  const canEdit=actions.canEdit&&item.type==='userMessage'&&!item.truncated&&!!turn.turnId;
  const act=(action:string)=>{
    setMenu(null);
    if(action==='copy')void copy();
    else if(action==='copied')copiedSuccessfully();
    else if(action==='edit'&&canEdit)actions.edit({item,turnId:turn.turnId});
    else if(action==='select'){setSelectionRequest(x=>x+1);selection(true);}
    else if(action==='menu')open();
    else if(action==='share')void Share.share({message:messagePlainText(display)}).catch(()=>relay.showNotice('分享失败，请重试。'));
  };
  return {anchor,copied,copy,canEdit,menu,setMenu,selecting,setSelecting:selection,selectionRequest,act,open,time:menuTime(turn.time),deviceId,threadId};
}

export function MessageActionOverlays({actions,text,nativeSelection}:{actions:ReturnType<typeof useMessageAction>;text:string;nativeSelection:boolean}){
  const {c}=useTheme();
  const viewport=useWindowDimensions();
  const {menu}=actions;
  const menuWidth=Math.min(240,viewport.width-32),menuHeight=(actions.time?32:0)+(actions.canEdit?4:3)*44;
  const right=menu?Math.max(16,viewport.width-menu.x-menu.width):16;
  const menuTop=menu?Math.max(52,Math.min(viewport.height-menuHeight-Math.min(menu.height,150)-36,menu.y-menuHeight-20)):52;
  return <>
    {!!menu&&<Modal transparent visible animationType="fade" onRequestClose={()=>actions.setMenu(null)}>
      <View style={{flex:1,backgroundColor:'#0005'}} onLayout={()=>{}}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭消息菜单" onPress={()=>actions.setMenu(null)} style={StyleSheet.absoluteFill}/>
        <View style={{position:'absolute',right:Math.min(right,viewport.width-menuWidth-16),top:menuTop,width:menuWidth,borderRadius:13,overflow:'hidden',backgroundColor:c.glass,elevation:12,shadowOpacity:.15,shadowRadius:20}}>
          {!!actions.time&&<Text style={{color:c.muted,fontSize:12,paddingHorizontal:15,height:32,lineHeight:32}}>{actions.time}</Text>}
          <ContextMenuGroup>
          <ContextMenuRow title="复制" Icon={Copy} onPress={()=>actions.act('copy')}/>
          {actions.canEdit&&<ContextMenuRow title="编辑" Icon={Pencil} onPress={()=>actions.act('edit')}/>}
          <ContextMenuRow title="选择文本" Icon={TextSelect} onPress={()=>actions.act('select')}/>
          <ContextMenuRow title="分享提示" Icon={Share2} onPress={()=>actions.act('share')}/>
          </ContextMenuGroup>
        </View>
        <View pointerEvents="none" style={{position:'absolute',right,width:Math.min(menu.width,viewport.width-32),top:menuTop+menuHeight+20,paddingHorizontal:15,paddingVertical:11,borderRadius:24,backgroundColor:c.bubble,elevation:8,shadowColor:c.shadow,shadowOpacity:.2,shadowRadius:8,shadowOffset:{width:0,height:3}}}><Text numberOfLines={5} style={{color:c.accent,fontSize:16,lineHeight:25}}>{messagePlainText(text)}</Text></View>
      </View>
    </Modal>}
    {actions.selecting&&!nativeSelection&&<Modal visible animationType="slide" onRequestClose={()=>actions.setSelecting(false)}>
      <SafeAreaView style={{flex:1,backgroundColor:c.bg}}><View style={styles.header}><Pressable accessibilityLabel="关闭文本选择" onPress={()=>actions.setSelecting(false)}><X color={c.text}/></Pressable><Text style={{color:c.text,fontSize:17}}>选择文本</Text><Pressable accessibilityLabel="复制全部文本" onPress={()=>void actions.copy()}>{actions.copied?<Check color={c.text}/>:<Copy color={c.text}/>}</Pressable></View>
        <TextInput multiline editable={false} selectTextOnFocus autoFocus value={messagePlainText(text)} style={{flex:1,color:c.text,fontSize:16,lineHeight:26,padding:20,textAlignVertical:'top'}}/>
      </SafeAreaView>
    </Modal>}
  </>;
}

function MessageEditor({target,deviceId,threadId,close,onFork,delivery,canEdit}:{target:EditTarget;deviceId:string;threadId:string;close:()=>void;onFork:(id:string)=>void;delivery:EditDelivery;canEdit:boolean}){
  const {c}=useTheme();
  const insets=useSafeAreaInsets();
  const [text,setText]=useState(target.item.text??''),[busy,setBusy]=useState(false),[error,setError]=useState(delivery.status==='unknown'?'上次发送结果待确认，请先检查会话列表。':'');
  const [files,setFiles]=useState<Attachment[]>([]),[picking,setPicking]=useState(false);
  const lock=useRef(false),mounted=useRef(true);
  const input=useRef<TextInput>(null);
  const focusTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const upload=useRef<AbortController|null>(null),fileRefs=useRef(files);fileRefs.current=files;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;clearTimeout(focusTimer.current);upload.current?.abort();if(delivery.status==='idle')for(const file of fileRefs.current)void relay.removeAttachment(deviceId,threadId,file.id).catch(()=>{});};},[deviceId,threadId,delivery]);
  const send=async()=>{
    if(lock.current||picking||!text.trim()||!canEdit||delivery.status==='unknown')return;
    lock.current=true;setBusy(true);setError('');
    try{
      const forkId=await deliverMessageEdit(delivery,()=>relay.sendCommand(deviceId,{type:'turn.edit',threadId,turnId:target.turnId,itemId:target.item.id,expectedText:target.item.text??'',text,...(files.length?{attachments:files.map(f=>f.id)}:{})}));
      try{await relay.loadCatalog(deviceId);}catch{relay.showNotice('消息已发送，会话列表稍后刷新');}
      if(mounted.current){onFork(forkId);close();}
    }catch(failure){if(mounted.current)setError(failure instanceof Error?failure.message:'发送失败，内容已保留。');}
    finally{lock.current=false;if(mounted.current)setBusy(false);}
  };
  const addFiles=async()=>{
    if(picking||busy||!canEdit||delivery.status!=='idle')return;
    messageHaptic();setPicking(true);
    const abort=new AbortController();upload.current=abort;
    try{
      const assets=await pickAttachments();
      for(const asset of assets.slice(0,MAX_ATTACHMENTS-files.length)){
        if(!mounted.current||abort.signal.aborted)break;
        if(asset.size>attachmentByteLimit(asset))throw new Error(`${asset.name} 超过附件大小限制`);
        const uploaded=await relay.uploadAttachment(deviceId,threadId,asset,abort.signal);
        if(mounted.current)setFiles(current=>[...current,uploaded]);
      }
    }catch(failure){if(mounted.current)setError(failure instanceof Error?failure.message:'无法读取附件');}
    finally{if(mounted.current)setPicking(false);}
  };
  return <Modal visible animationType="slide" onShow={()=>{clearTimeout(focusTimer.current);focusTimer.current=setTimeout(()=>{input.current?.focus();input.current?.setNativeProps({selection:{start:text.length,end:text.length}});},Platform.OS==='android'?300:0);}} onRequestClose={()=>{if(!busy)close();}}>
    <SafeAreaView style={{flex:1,backgroundColor:c.bg}}><KeyboardAvoidingView style={{flex:1}} keyboardVerticalOffset={Platform.OS==='ios'?insets.top:0} behavior={Platform.OS==='ios'?'padding':Platform.OS==='android'?'height':undefined}>
      <View style={[styles.header,{paddingHorizontal:16}]}><Pressable disabled={busy} accessibilityLabel="关闭编辑消息" onPress={close} style={[styles.editorClose,{backgroundColor:c.composer}]}><X size={24} strokeWidth={2} color={c.text}/></Pressable><Text style={{color:c.text,fontSize:16,fontWeight:'600'}}>编辑消息</Text><View style={{width:42}}/></View>
      <View style={{flex:1}}/>
      {!!error&&<Text accessibilityRole="alert" style={{color:c.danger,paddingHorizontal:20,paddingBottom:10}}>{error}</Text>}
      <View style={[styles.editorComposer,{backgroundColor:c.composer}]}>
        {(!!target.item.images?.length||!!target.item.files?.length)&&<Text style={{color:c.muted,fontSize:12,padding:6}}>保留原消息附件</Text>}
        {files.map(file=><View key={file.id} style={{flexDirection:'row',alignItems:'center',padding:6}}><Text numberOfLines={1} style={{color:c.text,flex:1}}>{file.name}</Text><Pressable disabled={busy||delivery.status!=='idle'} accessibilityLabel={`移除 ${file.name}`} onPress={()=>{setFiles(current=>current.filter(f=>f.id!==file.id));void relay.removeAttachment(deviceId,threadId,file.id).catch(()=>{});}}><X color={c.muted} size={18}/></Pressable></View>)}
        <ComposerInput compact inputRef={input} accessibilityLabel="编辑已发送消息" value={text} onChangeText={setText} multiline editable={!busy&&delivery.status==='idle'} selectionColor={c.accent} cursorColor={c.accent} maxLength={32000} onImages={()=>{}} imagesEnabled={false} onImageError={setError} style={{color:c.text,fontSize:16,lineHeight:23,padding:0,marginHorizontal:6,textAlignVertical:'top'}}/>
        <View style={styles.editorToolbar}>
          <Pressable disabled={busy||picking||!canEdit||files.length>=MAX_ATTACHMENTS||delivery.status!=='idle'} accessibilityLabel="添加编辑消息附件" onPress={()=>void addFiles()} style={styles.editorTool}>{picking?<ActivityIndicator color={c.muted}/>:<Plus size={24} strokeWidth={1.8} color={c.text}/>}</Pressable>
          <View style={{flex:1}}/>
          <Pressable accessibilityLabel="发送编辑后的消息" accessibilityHint="创建编辑分支并保留原会话" disabled={busy||picking||!canEdit||!text.trim()||delivery.status==='unknown'} onPress={()=>void send()} hitSlop={5} style={[styles.editorSend,{backgroundColor:c.accent,opacity:busy||picking||!canEdit||!text.trim()||delivery.status==='unknown'?0.5:1}]}>{busy?<ActivityIndicator color={c.onAccent}/>:<ArrowUp size={23} strokeWidth={2} color={c.onAccent}/>}</Pressable>
        </View>
      </View>
    </KeyboardAvoidingView></SafeAreaView>
  </Modal>;
}
const styles=StyleSheet.create({
  header:{height:56,paddingHorizontal:20,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},
  copyToast:{position:'absolute',top:8,left:16,right:16,minHeight:50,borderRadius:12,borderWidth:1,paddingHorizontal:12,flexDirection:'row',alignItems:'center',gap:12,shadowOpacity:.1,shadowRadius:12,shadowOffset:{width:0,height:3},elevation:2,zIndex:10},
  toastCheck:{width:17,height:17,borderRadius:9,alignItems:'center',justifyContent:'center'},
  editorClose:{width:42,height:42,borderRadius:21,alignItems:'center',justifyContent:'center'},
  editorComposer:{marginHorizontal:12,marginBottom:12,paddingHorizontal:8,paddingTop:12,paddingBottom:6,borderRadius:23},
  editorToolbar:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:4,minHeight:36},
  editorTool:{width:32,height:36,alignItems:'center',justifyContent:'center'},
  editorSend:{width:32,height:32,borderRadius:16,alignItems:'center',justifyContent:'center'},
});
