import React,{useEffect,useRef} from 'react';
import {View} from 'react-native';
import type {ScrollDirection} from '../../../../packages/client-shared/src/conversation-scroll';
import {subscribe} from '../bridge';
export function ConversationViewport({children,onScrollIntent}:{children:React.ReactNode;onScrollIntent:(direction:ScrollDirection)=>void}){
  const hovered=useRef(false);const callback=useRef(onScrollIntent);callback.current=onScrollIntent;
  useEffect(()=>subscribe('scrollIntent',value=>{if(hovered.current)callback.current(value.direction);}),[]);
  return <View style={{flex:1}} onPointerEnter={()=>{hovered.current=true;}} onPointerLeave={()=>{hovered.current=false;}}>{children}</View>;
}
