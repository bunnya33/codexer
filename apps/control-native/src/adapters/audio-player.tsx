import { useTheme } from '../../../mobile/src/styles';
import React,{useEffect,useRef,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {nativeAudioDocument} from '../../../../packages/client-shared/src/audio';
import type {AudioPlayerProps} from '../../../mobile/src/audio-player.types';
import {request,subscribe} from '../bridge';
import {randomId} from './runtime';
export function AudioPlayer({uri,onError,onEnded}:AudioPlayerProps){
  const { c } = useTheme();
  const id=useRef(randomId()).current;const [open,setOpen]=useState(false);const events=useRef({onError,onEnded});events.current={onError,onEnded};
  useEffect(()=>{const message=subscribe('previewMessage',event=>{if(event.id!==id)return;if(event.data==='audio-error')events.current.onError();if(event.data==='audio-ended')events.current.onEnded?.();});const closed=subscribe('previewClosed',event=>{if(event.id===id){setOpen(false);events.current.onEnded?.();}});void request('preview.open',{id,title:'音频播放',html:nativeAudioDocument(uri)}).then(()=>setOpen(true)).catch(()=>events.current.onError());return()=>{message();closed();void request('preview.close',{id}).catch(()=>{});};},[uri,id]);
  return <View style={{height:72,justifyContent:'center'}}><Pressable accessibilityRole="button" onPress={()=>{void request('preview.open',{id,title:'音频播放',html:nativeAudioDocument(uri)}).catch(onError);}}><Text style={{color:c.accent}}>{open?'返回音频播放窗口':'打开音频播放器'}</Text></Pressable></View>;
}
