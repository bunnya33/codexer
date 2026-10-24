import {existsSync} from 'node:fs';
import {join} from 'node:path';

export function agentProfile(appData:string,platform:NodeJS.Platform,exists:(path:string)=>boolean=existsSync):string {
  const legacy=join(appData,'@codexer','desktop');
  if(platform==='darwin')return legacy;
  const native=join(appData,'Codexer');
  // Prefer the most recently delivered native profile on Windows, then the
  // historical Electron npm-name profile. A new install uses the stable path.
  if(exists(join(native,'settings.json')))return native;
  return exists(join(legacy,'settings.json'))?legacy:native;
}
