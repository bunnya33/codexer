import React,{useEffect,useState} from 'react';
import {ActivityIndicator,Modal,Pressable,Switch,Text,View} from 'react-native';
import ControlApp from '../../mobile/App';
import AgentApp from './AgentApp';
import {boot,request,subscribe} from './bridge';
import {initializeSelection} from './adapters/selection-storage';
import {relay} from '../../mobile/src/relay';
class Boundary extends React.Component<{children:React.ReactNode},{error:boolean}>{
  state={error:false};
  static getDerivedStateFromError(){return {error:true};}
  componentDidCatch(){void request('storage.write',{key:'renderer-error',value:{at:Date.now(),code:'renderer-failed'}}).catch(()=>{});}
  render(){return this.state.error?<View style={{flex:1,padding:40,gap:12}}><Text style={{fontSize:22}}>界面加载失败</Text><Text>请重新打开客户端。若仍然出现，请保留诊断文件联系维护者。</Text></View>:this.props.children;}
}
export default function App(){
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[settings,setSettings]=useState(false),[closeExits,setCloseExits]=useState(false);
  useEffect(()=>{
    let disposed=false,diagnostics:(()=>void)|undefined;
    if(boot.mode==='control')void request<boolean>('diagnostics.enabled').then(enabled=>{
      if(!enabled||disposed)return;
      const capture=()=>{const view=relay.getSnapshot();void request('diagnostics.snapshot',{phase:view.phase,notice:view.notice,snapshots:Object.values(view.snapshots).map(snapshot=>({seq:snapshot.lastSeq,statuses:Object.values(snapshot.threads).map(thread=>thread.status)})),histories:Object.values(view.histories).map(history=>({count:history.turns.length,loading:history.loading,error:!!history.error}))}).catch(()=>{});};
      diagnostics=relay.subscribe(capture);capture();
    }).catch(()=>{});
    const off=subscribe('preferences',value=>{boot.serverUrl=value.serverUrl||boot.serverUrl;setCloseExits(value.closeExits);});
    const menu=subscribe('openSettings',()=>{if(boot.mode==='control')setSettings(true);});
    const backend=subscribe('backendError',()=>setError('本机服务已停止，请重新打开客户端。'));
    void Promise.all([request<{closeExits:boolean;serverUrl:string}>('preferences.read').then(value=>{boot.serverUrl=value.serverUrl;setCloseExits(value.closeExits);}),initializeSelection()]).then(()=>{setReady(true);requestAnimationFrame(()=>{void request('ready',{screen:boot.mode==='agent'?'agent-management':'conversation'});});}).catch(()=>setError('无法读取本机配置，请重新打开客户端。'));
    return()=>{disposed=true;diagnostics?.();off();menu();backend();};
  },[]);
  return <Boundary><View style={{flex:1,backgroundColor:'#fafafa'}}>{!!error&&<Text accessibilityRole="alert" style={{backgroundColor:'#fbe9eb',color:'#9e3343',padding:12}}>{error}</Text>}{ready?(boot.mode==='agent'?<AgentApp/>:<ControlApp/>):<View style={{flex:1,justifyContent:'center',alignItems:'center',gap:16}}><ActivityIndicator/><Text>正在读取本机配置…</Text></View>}
    <Modal visible={settings} transparent animationType="fade" onRequestClose={()=>setSettings(false)}><View style={{flex:1,backgroundColor:'#0005',justifyContent:'center',alignItems:'center'}}><View style={{padding:28,borderRadius:18,backgroundColor:'#fff',width:480,gap:22}}><Text style={{fontSize:22,fontWeight:'600'}}>RelayDesk 设置</Text><View style={{flexDirection:'row',alignItems:'center',gap:16}}><View style={{flex:1,gap:8}}><Text>关闭窗口时退出进程</Text><Text style={{fontSize:12,color:'#6b7d83'}}>默认缩小到托盘。启用后，每次退出均需确认。</Text></View><Switch accessibilityLabel="关闭窗口时退出进程" value={closeExits} onValueChange={value=>{void request('preferences.save',{closeExits:value}).then(()=>setCloseExits(value)).catch(()=>setError('设置保存失败'));}}/></View><Text style={{fontSize:12,color:'#6b7d83'}}>Windows · 0.2.1</Text><Pressable accessibilityRole="button" onPress={()=>setSettings(false)} style={{alignSelf:'flex-end',padding:12}}><Text>完成</Text></Pressable></View></View></Modal>
  </View></Boundary>;
}
