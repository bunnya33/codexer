import React,{useMemo,useRef,useState} from 'react';
import {ActivityIndicator,Image,Modal,PanResponder,Pressable,Text,View} from 'react-native';
import {SvgXml} from 'react-native-svg';
import type {ImageDirection,ImageGallery,ImagePreview} from '../../../../packages/client-shared/src/images';
import {ImageViewerHeader,ImageViewerNavigation} from '../../../mobile/src/image-viewer-controls';
export function ImageViewerImage({preview,onClose:_onClose}:{preview:ImagePreview;onClose:()=>void;onNavigate?:(direction:ImageDirection)=>void}){
  const [size,setSize]=useState({width:0,height:0}),[scale,setScale]=useState(1),[offset,setOffset]=useState({x:0,y:0}),[loading,setLoading]=useState(!preview.svgXml),[error,setError]=useState(false);
  const start=useRef(offset);const latest=useRef(offset);latest.current=offset;
  const pan=useMemo(()=>PanResponder.create({onMoveShouldSetPanResponder:()=>scale>1,onPanResponderGrant:()=>{start.current=latest.current;},onPanResponderMove:(_event,gesture)=>setOffset({x:Math.max(-size.width*(scale-1)/2,Math.min(size.width*(scale-1)/2,start.current.x+gesture.dx)),y:Math.max(-size.height*(scale-1)/2,Math.min(size.height*(scale-1)/2,start.current.y+gesture.dy))})}),[scale,size]);
  return <View style={{flex:1,minHeight:200,overflow:'hidden',backgroundColor:'#101616'}} onLayout={event=>setSize(event.nativeEvent.layout)}>
    <View {...pan.panHandlers} style={{flex:1,transform:[{translateX:offset.x},{translateY:offset.y},{scale}]}}>
      {preview.svgXml?<SvgXml xml={preview.svgXml} width={size.width} height={size.height} onError={()=>setError(true)}/>:<Image source={preview.source} resizeMode="contain" style={{flex:1,width:'100%',height:'100%'}} onLoad={()=>setLoading(false)} onError={()=>{setLoading(false);setError(true);}}/>}
    </View>
    {(loading||error)&&<View pointerEvents="none" style={{position:'absolute',inset:0,justifyContent:'center',alignItems:'center'}}>{error?<Text style={{color:'#fff'}}>图片暂不可用或格式不受支持</Text>:<ActivityIndicator color="#fff"/>}</View>}
    <View style={{position:'absolute',bottom:16,alignSelf:'center',flexDirection:'row',gap:12,backgroundColor:'#263333',borderRadius:12,padding:6}}>
      {[{label:'缩小',action:()=>{setScale(value=>Math.max(1,value-.5));setOffset({x:0,y:0});}},{label:`${Math.round(scale*100)}% · 重置`,action:()=>{setScale(1);setOffset({x:0,y:0});}},{label:'放大',action:()=>setScale(value=>Math.min(5,value+.5))}].map(item=><Pressable key={item.label} accessibilityRole="button" onPress={item.action} style={{padding:10}}><Text style={{color:'#fff'}}>{item.label}</Text></Pressable>)}
    </View>
  </View>;
}
export function ImageViewer({preview,onClose,onNavigate}:{preview:ImageGallery|null;onClose:()=>void;onNavigate:(direction:ImageDirection)=>void}){
  const image=preview?.images[preview.index];
  return <Modal visible={!!preview} transparent animationType="fade" onRequestClose={onClose}><View style={{flex:1,backgroundColor:'#101616'}}><ImageViewerHeader name={image?.name} onClose={onClose}/>{image&&<ImageViewerImage key={image.source.uri} preview={image} onClose={onClose}/>} {preview&&<ImageViewerNavigation gallery={preview} onNavigate={onNavigate}/>}</View></Modal>;
}
