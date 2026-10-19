import {request} from '../bridge';
export type ConversationSelection={deviceId:string;threadId:string};
let cache:Record<string,ConversationSelection>={};
export async function initializeSelection(){cache=(await request<typeof cache>('storage.read',{key:'selections'}))||{};}
export const readSelection=(scope:string)=>cache[scope]||null;
export function saveSelection(scope:string,selection:ConversationSelection){cache[scope]=selection;void request('storage.write',{key:'selections',value:cache}).catch(()=>{});}
