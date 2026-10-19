import { ThemeProvider } from '../../mobile/src/theme';
import { useTheme } from '../../mobile/src/styles';
import { ThemePicker } from '../../mobile/src/theme-picker';
import { Dialog } from '../../mobile/src/dialog';
import { WindowClosePreference } from './adapters/control-settings';
import { controlVersion } from './adapters/build-info';
import React,{useEffect,useState} from 'react';
import {ActivityIndicator,Text,View} from 'react-native';
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
function NativeApp(){
  const { c } = useTheme();
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[settings,setSettings]=useState(false);
  useEffect(()=>{
    let disposed=false,diagnostics:(()=>void)|undefined;
    if(boot.mode==='control')void request<boolean>('diagnostics.enabled').then(enabled=>{
      if(!enabled||disposed)return;
      const capture=()=>{const view=relay.getSnapshot();void request('diagnostics.snapshot',{phase:view.phase,notice:view.notice,snapshots:Object.values(view.snapshots).map(snapshot=>({seq:snapshot.lastSeq,statuses:Object.values(snapshot.threads).map(thread=>thread.status)})),histories:Object.values(view.histories).map(history=>({count:history.turns.length,loading:history.loading,error:!!history.error}))}).catch(()=>{});};
      diagnostics=relay.subscribe(capture);capture();
    }).catch(()=>{});
    const off=subscribe('preferences',value=>{boot.serverUrl=value.serverUrl||boot.serverUrl;});
    const menu=subscribe('openSettings',()=>{if(boot.mode==='control')setSettings(true);});
    const backend=subscribe('backendError',()=>setError('本机服务已停止，请重新打开客户端。'));
    void Promise.all([request<{closeExits:boolean;serverUrl:string}>('preferences.read').then(value=>{boot.serverUrl=value.serverUrl;}),initializeSelection()]).then(()=>{setReady(true);requestAnimationFrame(()=>{void request('ready',{screen:boot.mode==='agent'?'agent-management':'conversation'});});}).catch(()=>setError('无法读取本机配置，请重新打开客户端。'));
    return()=>{disposed=true;diagnostics?.();off();menu();backend();};
  },[]);
  return <Boundary><View style={{flex:1,backgroundColor:c.bg}}>{!!error&&<Text accessibilityRole="alert" style={{backgroundColor:c.warningBg,color:c.danger,padding:12}}>{error}</Text>}{ready?(boot.mode==='agent'?<AgentApp/>:<ControlApp/>):<View style={{flex:1,justifyContent:'center',alignItems:'center',gap:16}}><ActivityIndicator color={c.accent}/><Text style={{color:c.text}}>正在读取本机配置…</Text></View>}
    <Dialog open={settings} title="RelayDesk 设置" onClose={()=>setSettings(false)}><ThemePicker/><WindowClosePreference/><Text style={{fontSize:12,color:c.muted}}>Windows · {controlVersion}</Text></Dialog>
  </View></Boundary>;
}

export default function App(){return <ThemeProvider><NativeApp/></ThemeProvider>;}
