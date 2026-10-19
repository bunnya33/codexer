import {request} from '../bridge';
import type {WidgetState} from '../../../../packages/client-shared/src/previews';
export type PreviewSnapshot={state:WidgetState|null;tweaks:Record<string,string|number|boolean>};
export const readPreviewState=(key:string)=>request<PreviewSnapshot|null>('storage.read',{key:'preview:'+key});
export async function savePreviewState(key:string,value:PreviewSnapshot){if(JSON.stringify(value).length>24000)throw new Error('预览状态过大');await request('storage.write',{key:'preview:'+key,value});}
