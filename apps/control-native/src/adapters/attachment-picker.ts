import {request} from '../bridge';
export type PickedFile={path:string;uri:string;name:string;size:number;mimeType:string};
export type AttachmentAsset={name:string;size:number;mimeType:string;readChunk:(offset:number,length:number)=>Promise<string>};
export async function pickAttachments():Promise<AttachmentAsset[]>{
  const picked=await request<PickedFile[]>('pick',{kind:'files'});
  return picked.map(file=>({...file,readChunk:(position:number,length:number)=>request<string>('readChunk',{path:file.path,position,length})}));
}
