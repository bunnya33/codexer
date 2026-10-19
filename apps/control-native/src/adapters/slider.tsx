import { useTheme } from '../../../mobile/src/styles';
import React,{useMemo,useRef,useState} from 'react';
import {PanResponder,View} from 'react-native';
export function Slider({value,min,max,step=1,label,disabled=false,onChange,onCommit}:{value:number;min:number;max:number;step?:number;label:string;disabled?:boolean;onChange:(value:number)=>void;onCommit?:(value:number)=>void}){
  const { c } = useTheme();
  const [width,setWidth]=useState(0);const current=useRef(value);current.current=value;
  const change=useRef(onChange);change.current=onChange;const commit=useRef(onCommit);commit.current=onCommit;
  const responder=useMemo(()=>{
    const update=(x:number)=>{if(disabled||!width)return;const next=Math.max(min,Math.min(max,min+Math.round((x/width*(max-min))/step)*step));current.current=next;change.current(next);};
    return PanResponder.create({onStartShouldSetPanResponder:()=>!disabled,onMoveShouldSetPanResponder:()=>!disabled,onPanResponderGrant:event=>update(event.nativeEvent.locationX),onPanResponderMove:event=>update(event.nativeEvent.locationX),onPanResponderRelease:()=>commit.current?.(current.current)});
  },[width,min,max,step,disabled]);
  const percent=Math.max(0,Math.min(100,(value-min)/(max-min||1)*100));
  return <View accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{min,max,now:value}} accessibilityActions={[{name:'increment'},{name:'decrement'}]} onAccessibilityAction={event=>{const next=Math.max(min,Math.min(max,value+(event.nativeEvent.actionName==='increment'?step:-step)));onChange(next);onCommit?.(next);}} onLayout={event=>setWidth(event.nativeEvent.layout.width)} {...responder.panHandlers} style={{height:44,justifyContent:'center',opacity:disabled ? .4 : 1}}>
    <View style={{height:5,borderRadius:3,backgroundColor:c.sliderTrack}}><View style={{height:5,borderRadius:3,backgroundColor:c.slider,width:`${percent}%`}}/></View><View style={{position:'absolute',left:`${percent}%`,marginLeft:-9,width:18,height:18,borderRadius:9,backgroundColor:c.thumb,borderColor:c.thumbBorder,borderWidth:1}}/>
  </View>;
}
