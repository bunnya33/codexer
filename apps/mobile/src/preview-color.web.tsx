export function PreviewColor({value,label,onChange}:{value:string;label:string;onChange:(value:string)=>void}) {
  return <input type="color" aria-label={label} value={value} onChange={event=>onChange(event.target.value)} style={{width:56,height:36}} />;
}
