import {useEffect,useState} from 'react';
import {TextInput,View} from 'react-native';
export function PreviewColor({value,label,onChange}:{value:string;label:string;onChange:(value:string)=>void}) {
  const [draft,setDraft]=useState(value);
  useEffect(()=>setDraft(value),[value]);
  return <View style={{flexDirection:'row',alignItems:'center',gap:10}}><View style={{width:26,height:26,borderRadius:5,backgroundColor:value}} /><TextInput accessibilityLabel={label} value={draft} autoCapitalize="none" onChangeText={next=>{setDraft(next);if(/^#[\da-f]{6}$/i.test(next))onChange(next);}} onBlur={()=>setDraft(value)} style={{flex:1,color:'#191d1e',borderWidth:1,borderColor:'#e8e9e9',borderRadius:7,padding:10,fontSize:14}} /></View>;
}
