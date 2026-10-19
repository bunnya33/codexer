import {request,subscribe} from '../bridge';
import {randomId} from './runtime';
import type {FileSource} from '../../../mobile/src/file-transfer';
import type {FileInfo} from '../../../../packages/protocol/src/files';
export async function downloadFile(source:FileSource,info:FileInfo,signal:AbortSignal,progress:(fraction:number)=>void){
  if(signal.aborted)throw new Error('file-cancelled');
  const id=randomId();
  const remove=subscribe('downloadProgress',event=>{if(event.id===id)progress(event.progress);});
  const abort=()=>{void request('download.cancel',{id});};
  signal.addEventListener('abort',abort,{once:true});
  try {await request('download',{id,...source,name:info.name,size:info.size}); if(signal.aborted)throw new Error('file-cancelled');}
  finally {remove();signal.removeEventListener('abort',abort);}
}
