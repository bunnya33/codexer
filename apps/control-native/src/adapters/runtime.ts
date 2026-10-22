import {boot, desktop, request} from '../bridge';
export const randomId = ():string => desktop.randomId();
export const defaultRelayUrl = () => boot.serverUrl || '';
export const readCredentials = async () => {const value=await request('credentials.read'); return value ? JSON.stringify(value) : null;};
export const saveCredentials = (value:string) => request<void>('credentials.save',{value});
export const clearCredentials = () => request<void>('credentials.clear');
export const copyText = async (value:string) => {if(await request<boolean>('clipboard.write',{value})!==true)throw new Error('clipboard-unavailable');};
export const confirmAction = (title:string,message:string) => request<boolean>('confirm',{title,message});
