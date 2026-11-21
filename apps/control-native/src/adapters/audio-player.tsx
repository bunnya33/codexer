import { useTheme } from '../../../mobile/src/styles';
import React,{useEffect,useRef,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {nativeMediaDocument} from '../../../../packages/client-shared/src/audio';
import type {AudioPlayerProps} from '../../../mobile/src/audio-player.types';
import {request,subscribe} from '../bridge';
import {randomId} from './runtime';
export function AudioPlayer({kind,uri,onError,onEnded}:AudioPlayerProps){
  const { c } = useTheme();
  const id=useRef(randomId()).current;const [open,setOpen]=useState(false);const events=useRef({onError,onEnded});events.current={onError,onEnded};
  const label = kind === "video" ? "视频" : "音频";
  const title = label + "播放";
  useEffect(()=>{const message=subscribe('previewMessage',event=>{if(event.id!==id)return;if(event.data===`${kind}-error`)events.current.onError();if(event.data===`${kind}-ended`)events.current.onEnded?.();});const closed=subscribe('previewClosed',event=>{if(event.id===id){setOpen(false);events.current.onEnded?.();}});void request('preview.open',{id,title,html:nativeMediaDocument(uri,kind)}).then(()=>setOpen(true)).catch(()=>events.current.onError());return()=>{message();closed();void request('preview.close',{id}).catch(()=>{});};},[uri,id,kind,title]);
  return <View style={{height:72,justifyContent:'center'}}><Pressable accessibilityRole="button" onPress={()=>{void request('preview.open',{id,title,html:nativeMediaDocument(uri,kind)}).catch(onError);}}><Text style={{color:c.accent}}>{open ? `返回${title}窗口` : `打开${label}播放器`}</Text></Pressable></View>;
}
