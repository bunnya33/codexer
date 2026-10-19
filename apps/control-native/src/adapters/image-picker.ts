import {request} from '../bridge';
import type {PickedFile} from './attachment-picker';
export type ImagePickerAsset={uri:string;width:number;height:number;fileName?:string;mimeType?:string;base64?:string|null;fileSize?:number};
export async function launchImageLibraryAsync(options:{selectionLimit?:number;[key:string]:unknown}={}){
  const files=(await request<PickedFile[]>('pick',{kind:'images'})).slice(0,options.selectionLimit||4);
  const assets=await Promise.all(files.map(async file=>{
    const converted=await request<{base64:string;width:number;height:number}>('image.convert',{path:file.path,edge:1600,quality:.85});
    return {...converted,uri:file.uri,fileName:file.name.replace(/\.[^.]+$/,'.jpg'),mimeType:'image/jpeg'};
  }));
  return {canceled:!assets.length,assets};
}
export const requestCameraPermissionsAsync=async()=>({granted:false});
export const launchCameraAsync=async(_options?:unknown)=>({canceled:true,assets:[] as ImagePickerAsset[]});
