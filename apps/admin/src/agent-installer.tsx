import {useEffect,useRef,useState} from 'react';
import {Monitor,Upload,X} from 'lucide-react';
import {agentVersionPattern,MAX_AGENT_INSTALLER_BYTES} from '../../../packages/shared/src/agent-release';
import type {AgentRelease} from '../../../packages/shared/src/agent-release';
import * as api from './api';

export function AgentInstaller(){
  const [release,setRelease]=useState<AgentRelease|null>(null),[version,setVersion]=useState(''),[file,setFile]=useState<File|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0),[error,setError]=useState(''),[note,setNote]=useState('');
  const abort=useRef<AbortController|null>(null),live=useRef(true),input=useRef<HTMLInputElement>(null);
  const refresh=async()=>{setLoading(true);setError('');try{const value=await api.agentRelease();if(live.current)setRelease(value);}catch(e){if(live.current)setError(e instanceof Error?e.message:'读取失败');}finally{if(live.current)setLoading(false);}};
  useEffect(()=>{live.current=true;void refresh();return()=>{live.current=false;abort.current?.abort();};},[]);
  const upload=async()=>{
    if(abort.current||!file)return;
    if(!agentVersionPattern.test(version.trim())){setError('版本号格式如 0.2.6');return;}
    if(!file.name.toLowerCase().endsWith('.exe')||file.size<128||file.size>MAX_AGENT_INSTALLER_BYTES){setError('请选择不超过 256 MiB 的 Windows EXE 安装包');return;}
    const controller=new AbortController();abort.current=controller;setBusy(true);setProgress(0);setError('');setNote('');
    try{const value=await api.uploadAgentRelease(file,version.trim(),controller.signal,value=>{if(live.current)setProgress(value);});if(live.current){setRelease(value);setFile(null);if(input.current)input.current.value='';setNote('安装包已发布，控制端现在可下载此版本。');}}
    catch(e){if(live.current)setError(controller.signal.aborted?'上传已取消，请刷新确认当前版本':e instanceof Error?e.message:'上传失败，请重试');}
    finally{abort.current=null;if(live.current)setBusy(false);}
  };
  return <section className="card agent-installer" aria-label="PC Agent 安装包管理"><h2><Monitor size={20}/>PC Agent · Windows 安装包</h2><p className="muted">上传成功后，控制端“设置 → 下载 PC Agent”提供此安装包。新包上传完成前，继续提供原版本。</p>
    {loading?<p role="status">正在读取安装包…</p>:release?<div className="installer-current"><strong>当前版本 {release.version}</strong><span>{release.name} · {(release.size/1024/1024).toFixed(1)} MiB</span><span>上传于 {new Date(release.uploadedAt).toLocaleString('zh-CN')}</span><code>SHA-256：{release.sha256}</code></div>:<p className="muted">尚未上传安装包</p>}
    <form onSubmit={e=>{e.preventDefault();void upload();}}><div className="installer-fields"><label>安装包版本<input aria-label="安装包版本" placeholder="例如 0.2.6" value={version} maxLength={80} disabled={busy} onChange={e=>setVersion(e.target.value)} required/></label><label>EXE 安装包<input ref={input} aria-label="EXE 安装包" type="file" accept=".exe" disabled={busy} onChange={e=>{setFile(e.target.files?.[0]??null);setError('');setNote('');}} required/></label></div>
    <div className="actions"><button className="primary" disabled={busy||loading||!file||!version.trim()}><Upload size={16}/>{busy?(progress>=1?'校验并发布…':`上传中 ${Math.floor(progress*100)}%`):'上传并发布'}</button>{busy?<button type="button" onClick={()=>abort.current?.abort()}><X size={16}/>取消上传</button>:<button type="button" disabled={loading} onClick={()=>void refresh()}>刷新</button>}</div>
    {busy&&<progress aria-label="安装包上传进度" max={1} value={progress}/>}
    </form>{!!error&&<p className="error" role="alert">{error}</p>}{!!note&&<p className="positive" role="status">{note}</p>}<p className="footnote">仅支持 Windows EXE，最大 256 MiB。以最近一次成功上传的版本为准，服务器更新和重启不会清除安装包。</p>
  </section>;
}
