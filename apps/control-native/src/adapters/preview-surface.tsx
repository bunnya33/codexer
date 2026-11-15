import { useTheme } from '../../../mobile/src/styles';
import React,{useCallback,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {openPreviewDocument} from '../preview-document';
import type {PreviewSurfaceProps} from '../../../mobile/src/preview-surface.types';
import {request,subscribe} from '../bridge';
import {controlPlatform} from './build-info';
export function PreviewSurface({document,url,channel,height,expanded,title,kind,onMessage,surfaceRef}:PreviewSurfaceProps){
  const { c } = useTheme();
  const [error,setError]=useState(''),[opened,setOpened]=useState(false);const alive=useRef(true);
  const receive=useRef(onMessage);receive.current=onMessage;
  const pending=useRef<AbortController|null>(null);
  const open=useCallback(async()=>{if(pending.current)return;const abort=new AbortController();pending.current=abort;try{setError('');await openPreviewDocument({request,subscribe},{id:channel,title,document,url},abort.signal);if(alive.current)setOpened(true);}catch{if(alive.current&&!abort.signal.aborted)setError(controlPlatform === 'macOS' ? '无法打开内容预览，请重试或查看本机诊断。' : '无法打开内容预览，请确认系统已安装 Microsoft Edge WebView2。');}finally{if(pending.current===abort)pending.current=null;}},[channel,document,url,title]);
  useEffect(()=>{alive.current=true;const off=subscribe('previewMessage',event=>{if(event.id===channel){try{const value=JSON.parse(event.data);if(value.channel===channel&&!['shell-ready','document-accepted'].includes(value.type))receive.current(value);}catch{}}});const closed=subscribe('previewClosed',event=>{if(event.id===channel){pending.current?.abort();setOpened(false);}});return()=>{alive.current=false;pending.current?.abort();off();closed();void request('preview.close',{id:channel}).catch(()=>{});};},[channel]);
  useEffect(()=>{if(expanded)void open();return()=>{pending.current?.abort();pending.current=null;};},[expanded,open]);
  useImperativeHandle(surfaceRef,()=>({send:message=>{void request('preview.send',{id:channel,message}).catch(()=>{});}}),[channel]);
  return <View style={{height:expanded?undefined:Math.min(220,height),flex:expanded?1:undefined,backgroundColor:c.code,justifyContent:'center',alignItems:'center',gap:12,padding:24}}><Text style={{fontSize:15,color:c.text}}>{title}</Text><Pressable accessibilityRole="button" onPress={()=>void open()} style={{paddingHorizontal:20,paddingVertical:12,borderRadius:10,backgroundColor:c.accent}}><Text style={{color:c.onAccent}}>{opened?'返回预览窗口':kind==='document'?'打开文档预览':'打开交互预览'}</Text></Pressable><Text style={{fontSize:12,color:c.muted}}>{error||(kind==='document'?'在独立窗口分页阅读、缩放和搜索。':'在独立窗口查看，支持参数调整和反馈。')}</Text></View>;
}
