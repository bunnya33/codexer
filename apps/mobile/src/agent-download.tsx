import {useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Pressable,Text,View} from 'react-native';
import {Download,RefreshCw} from 'lucide-react-native';
import type {AgentRelease} from '../../../packages/shared/src/agent-release';
import {relay} from './relay';
import {downloadFile} from './file-download';
import {fileError} from './file-transfer';
import {useTheme} from './styles';

export function AgentDownload({url}:{url:string}){
  const {c,s}=useTheme();
  const [release,setRelease]=useState<AgentRelease|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState(''),[progress,setProgress]=useState(0),[revision,setRevision]=useState(0);
  const task=useRef<AbortController|null>(null),live=useRef(true);
  useEffect(()=>{
    live.current=true;const controller=new AbortController();setLoading(true);setRelease(null);setError('');
    void relay.agentRelease(controller.signal).then(value=>{if(!controller.signal.aborted)setRelease(value);}).catch(e=>{if(!controller.signal.aborted)setError(fileError(e));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>{live.current=false;controller.abort();task.current?.abort();};
  },[url,revision]);
  const download=async()=>{
    if(task.current)return;const controller=new AbortController();task.current=controller;setBusy(true);setError('');setNote('');setProgress(0);
    try{
      // Read again when clicked, so an already-open settings panel also gets the latest upload.
      const latest=await relay.agentRelease(controller.signal);if(controller.signal.aborted)return;if(!latest)throw new Error('agent-release-unavailable');
      if(live.current)setRelease(latest);
      await downloadFile(relay.agentInstallerSource(latest.id),{name:latest.name,size:latest.size,version:latest.sha256},controller.signal,value=>{if(live.current)setProgress(value);});
      if(live.current)setNote('已交给系统保存，请查看下载位置');
    }catch(e){if(live.current)setError(controller.signal.aborted?'下载已取消':fileError(e));}
    finally{task.current=null;if(live.current)setBusy(false);}
  };
  return <View style={{gap:10}}><View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}><Text style={{fontSize:12,color:c.muted}}>PC Agent · Windows</Text><Pressable accessibilityRole="button" accessibilityLabel="刷新 PC Agent 安装包" disabled={loading||busy} onPress={()=>setRevision(value=>value+1)} style={s.iconButton}><RefreshCw size={16} color={c.muted}/></Pressable></View>
    {loading?<ActivityIndicator color={c.muted}/>:<Text style={{fontSize:13,color:c.muted}}>{release?`版本 ${release.version} · ${(release.size/1024/1024).toFixed(1)} MiB`:error?'无法读取安装包，请点击刷新重试':'管理员尚未上传安装包'}</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel="下载 PC Agent EXE" disabled={loading||busy||!release} onPress={()=>void download()} style={{flexDirection:'row',alignItems:'center',gap:10,padding:14,borderRadius:12,backgroundColor:c.settingsGroup,opacity:loading||!release?.id?0.5:1}}><Download size={19} color={c.accent}/><Text style={{color:c.accent,fontSize:14}}>{busy?`正在下载${progress?` ${Math.floor(progress*100)}%`:'…'}`:'下载 PC Agent EXE'}</Text></Pressable>
    {busy&&<Pressable accessibilityRole="button" onPress={()=>task.current?.abort()}><Text style={{color:c.muted}}>取消下载</Text></Pressable>}
    {!!error&&<Text accessibilityRole="alert" style={{color:c.danger,fontSize:13}}>{error}</Text>}{!!note&&<Text accessibilityRole="alert" style={{color:c.muted,fontSize:13}}>{note}</Text>}
  </View>;
}
