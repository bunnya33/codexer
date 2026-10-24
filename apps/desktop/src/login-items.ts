import type {Settings} from 'electron';

export function agentLoginItemSettings(platform:NodeJS.Platform,enabled:boolean,executable:string):Settings[] {
  if(platform!=='win32')return [{openAtLogin:enabled}];
  // Remove only the historical Agent value names. Native Agent used Codexer;
  // older Electron builds used the npm name or application ID.
  const previous:Settings[]=['Codexer','@codexer/desktop','com.codexer.connector'].map(name=>({name,openAtLogin:false}));
  return [...previous,{name:'Codexer Agent',openAtLogin:enabled,path:executable,args:[]}];
}
