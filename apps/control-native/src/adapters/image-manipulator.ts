import {request} from '../bridge';
export const SaveFormat={JPEG:'jpeg'} as const;
export async function manipulateAsync(uri:string,actions:{resize?:{width?:number;height?:number}}[],options:{compress?:number;base64?:boolean;format?:string}){
  const size=actions.find(action=>action.resize)?.resize;
  const path=decodeURI(uri.replace(/^file:\/\//,'' )).replace(/^\/([a-z]:)/i,'$1');
  const image=await request<{base64:string;width:number;height:number}>('image.convert',{path,edge:size?.width||size?.height||1600,quality:options.compress||.85});
  return {...image,uri:'data:image/jpeg;base64,'+image.base64};
}
