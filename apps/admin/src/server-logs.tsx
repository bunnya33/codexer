import {useEffect,useRef,useState} from 'react';
import {ChevronDown,Copy,RefreshCw} from 'lucide-react';
import {ApiError,serverLogs} from './api';
import type {ServerLog,ServerLogFilter,ServerLogPage} from './api';
import {copyText} from '../../../packages/client-shared/src/browser';

const labels:Record<string,string>={connection:'连接',protocol:'协议',storage:'存储',http:'接口',background:'后台任务'};
const reasons:Record<string,string>={'device-connected':'设备已连接','invalid-message':'消息未通过协议校验','invalid-json':'消息不是有效的 JSON','device-mismatch':'消息中的设备标识不匹配','stale-snapshot':'设备快照序号落后','thread-limit':'同步会话数量超过上限','payload-too-large':'消息体积超过上限','backpressure':'消息积压，连接已关闭','relay-storage-error':'处理设备消息时存储失败','storage-error':'存储异常，连接已关闭','session-expired':'登录会话已过期','connection-replaced':'连接被另一实例替换','transport-error':'网络连接异常中断','write-error':'向连接写入失败','client-closed':'客户端正常关闭','user-disconnected':'用户主动断开','relay-closing':'服务器正在停止','connection-closed':'连接已关闭','peer-closed':'对端关闭连接','background-operation-failed':'服务器后台任务失败','server-error':'服务器接口执行失败','rate-limited':'请求过于频繁'};
const severity={info:'信息',warn:'警告',error:'错误'};
Object.assign(reasons,{'sequence-gap':'消息序号不连续，已请求重新同步','heartbeat-timeout':'心跳超时','revoked':'设备登录已被撤销','unauthorized':'设备连接未通过身份验证','text-required':'消息必须使用文本格式','origin-denied':'连接来源未获允许'});
const initiators:Record<string,string>={server:'服务器主动关闭',peer:'对端发起关闭',transport:'传输异常，未完成正常关闭'};
const rules:Record<string,string>={type:'字段类型错误',required:'缺少必填字段',minimum:'数值低于下限',maximum:'数值超过上限',enum:'字段值不在允许范围',const:'固定字段值不匹配',format:'字段格式错误',uniqueIds:'标识重复',uniqueThreadIds:'会话标识重复',matchesRecordKey:'会话 ID 与记录键不匹配',tokenCountsWithinTotals:'Token 子项超过总数','protocol-constraint':'未满足协议约束'};
function explainRule(rule:string){const [kind,limit]=rule.split(':');return rules[rule]||(kind==='maxBytes'?`内容超过 ${limit} 字节`:kind==='maxProperties'?`最多允许 ${limit} 个会话`:kind==='maxLength'?`文本最多 ${limit} 个 UTF-16 单位`:kind==='minLength'?`文本至少 ${limit} 个 UTF-16 单位`:rule);}
function LogRow({entry}:{entry:ServerLog}) {
  const [open,setOpen]=useState(false);
  const [copyState,setCopyState]=useState<'idle'|'copying'|'copied'|'failed'>('idle');
  async function copy(){setCopyState('copying');try{await copyText(JSON.stringify(entry,null,2));setCopyState('copied');}catch{setCopyState('failed');}}
  const fields:[string,unknown][]=[['连接类型',entry.source==='device'?'PC 连接器':entry.source==='client'?'控制端':undefined],['关闭发起方',entry.initiator?initiators[entry.initiator]||entry.initiator:undefined],['连接时长',entry.durationMs!==undefined?`${Math.floor(entry.durationMs/1000)} 秒`:undefined],['连接 ID',entry.connectionId],['设备 ID',entry.deviceId],['会话 ID',entry.threadId],['连接器版本',entry.agentVersion],['消息类型',entry.messageType],['关闭代码',entry.closeCode],['事件序号',entry.seq],['消息字节数',entry.messageBytes],['会话字节数',entry.threadBytes],['同步会话数',entry.threadCount],['HTTP 状态',entry.httpStatus],['接口',entry.route],['SQLSTATE',entry.sqlState]];
  return <article className={'server-log-entry '+entry.level}>
    <button className="server-log-summary" aria-expanded={open} onClick={()=>setOpen(!open)}><time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString('zh-CN',{hour12:false})}</time><span className={'server-log-level '+entry.level}>{severity[entry.level]}</span><span className="server-log-category">{labels[entry.category]||entry.category}</span><span className="server-log-reason"><strong>{reasons[entry.code]||entry.code}</strong><code>{entry.code}{entry.closeCode?` · ${entry.closeCode}`:''}{entry.messageType?` · ${entry.messageType}`:''}</code></span><ChevronDown size={17} className={open?'expanded':''}/></button>
    {open&&<div className="server-log-details"><dl>{fields.filter(([,value])=>value!==undefined&&value!=='').map(([name,value])=><div key={name}><dt>{name}</dt><dd>{String(value)}</dd></div>)}</dl>{Boolean(entry.issues?.length)&&<div className="server-log-issues"><strong>校验失败字段</strong>{entry.issues!.map((issue,index)=><div key={index}>{explainRule(issue.rule)}<code>{issue.path} · {issue.rule}</code></div>)}</div>}<button disabled={copyState==='copying'} onClick={()=>void copy()}><Copy size={15}/>{copyState==='copying'?'正在复制…':copyState==='copied'?'已复制':copyState==='failed'?'重试复制':'复制诊断'}</button>{copyState==='copied'&&<p role="status" className="server-log-copy-note">已复制脱敏诊断</p>}{copyState==='failed'&&<div className="server-log-manual-copy"><p role="alert">自动复制失败，请复制下方已选中的诊断文本。</p><textarea aria-label="手动复制诊断内容" readOnly autoFocus value={JSON.stringify(entry,null,2)} onFocus={event=>event.currentTarget.select()}/></div>}</div>}
  </article>;
}
const empty:ServerLogFilter={level:'',category:'',deviceId:'',code:''};
export function ServerLogsPanel({onUnauthorized}:{onUnauthorized:()=>void}) {
  const [draft,setDraft]=useState(empty),[filter,setFilter]=useState(empty),[page,setPage]=useState<ServerLogPage|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const request=useRef<AbortController|null>(null),generation=useRef(0),pageRef=useRef<ServerLogPage|null>(null);
  const unauthorized=useRef(onUnauthorized);unauthorized.current=onUnauthorized;
  async function load(older=false) {
    if(older&&request.current)return;
    request.current?.abort();
    const controller=new AbortController(),current=++generation.current;request.current=controller;
    setLoading(true);setError('');
    const before=older?pageRef.current?.nextCursor??null:null;
    try {
      const result=await serverLogs(filter,before,controller.signal);
      if(controller.signal.aborted||generation.current!==current)return;
      const next=older&&pageRef.current?{...result,entries:[...pageRef.current.entries,...result.entries].filter((entry,index,all)=>all.findIndex(item=>item.id===entry.id)===index)}:result;
      pageRef.current=next;setPage(next);
    }catch(reason){if(controller.signal.aborted||generation.current!==current)return;if(reason instanceof ApiError&&reason.status===401)unauthorized.current();else setError(reason instanceof Error?reason.message:'读取服务器日志失败');}
    finally{if(generation.current===current){request.current=null;setLoading(false);}}
  }
  useEffect(()=>{pageRef.current=null;setPage(null);void load();return()=>{generation.current++;request.current?.abort();request.current=null;};},[filter]);
  const edit=(key:keyof ServerLogFilter,value:string)=>setDraft(current=>({...current,[key]:value}));
  return <section aria-label="服务器日志" className="server-logs">
    <div className="page-head"><div><h2>服务器日志</h2><p className="muted">查看设备断连、协议拒绝和服务器异常，展开一条日志可查看具体原因。</p></div><button aria-label="刷新服务器日志" disabled={loading} onClick={()=>{if(!request.current)void load();}}><RefreshCw size={16} className={loading?'spinning':''}/>刷新</button></div>
    <form className="card server-log-filters" onSubmit={event=>{event.preventDefault();setFilter({...draft});}}><label>级别<select value={draft.level} onChange={event=>edit('level',event.target.value)}><option value="">全部级别</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option></select></label><label>分类<select value={draft.category} onChange={event=>edit('category',event.target.value)}><option value="">全部分类</option>{Object.entries(labels).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></label><label>设备 ID<input value={draft.deviceId} maxLength={160} placeholder="按设备筛选" onChange={event=>edit('deviceId',event.target.value)}/></label><label>错误代码<input value={draft.code} maxLength={100} placeholder="例如 invalid-message" onChange={event=>edit('code',event.target.value)}/></label><button className="primary" type="submit">筛选</button><button type="button" onClick={()=>{setDraft(empty);setFilter({...empty});}}>重置</button></form>
    {error&&<p className="notice error" role="alert">{error}{page?'；下方保留上次读取的日志。':''}</p>}
    {page&&<p className="server-log-retention muted">最近保留 {page.retained} / {page.capacity} 条 · {page.persistent?'日志已保存，服务器重启后可继续查看':'日志目前仅保留在内存，未写入磁盘'} · {new Date(page.capturedAt).toLocaleTimeString('zh-CN')} 更新</p>}
    <div className="card server-log-list" aria-busy={loading}>{page?.entries.map(entry=><LogRow key={entry.id} entry={entry}/>)}{!page?.entries.length&&<p className="empty">{loading?'正在读取日志…':error?'暂时无法读取日志':'没有符合条件的日志。新错误发生后会在这里记录。'}</p>}</div>
    {page?.nextCursor!==null&&page?.nextCursor!==undefined&&<button className="server-log-more" disabled={loading} onClick={()=>void load(true)}>{loading?'正在读取…':'加载更早日志'}</button>}
    <p className="footnote">日志不包含任务正文、密码、令牌或文件内容。记录从本版本启用后开始，按容量滚动保留。</p>
  </section>;
}
