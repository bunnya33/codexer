import {ClassicLevel} from 'classic-level';
import {cp,mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

/** Read a stable copy, leaving Chromium's database and lock untouched. */
export async function readLegacyControl(directory:string,serverUrl:string):Promise<{url:string;session:string}|null>{
  if(!serverUrl)return null;
  const origin=new URL(serverUrl).origin;
  const source=join(directory,'Local Storage','leveldb');
  const entries:string[]=await readdir(source,{encoding:'utf8'}).catch(()=>[] as string[]); if(!entries.includes('CURRENT'))return null;
  const snapshot=await mkdtemp(join(tmpdir(),'codexer-native-migrate-'));
  let database:ClassicLevel<Buffer,Buffer>|undefined;
  try {
    const names=entries.filter(name=>name==='CURRENT'||/^MANIFEST-\d+$/.test(name)||/^\d+\.(log|ldb|sst)$/.test(name));
    const before=await Promise.all(names.map(name=>stat(join(source,name))));
    if(before.reduce((sum,file)=>sum+file.size,0)>64*1024*1024)return null;
    for(const name of names)await cp(join(source,name),join(snapshot,name));
    const after=await Promise.all(names.map(name=>stat(join(source,name))));
    if(before.some((file,index)=>file.size!==after[index]!.size||file.mtimeMs!==after[index]!.mtimeMs)||!Buffer.from(await readFile(join(source,'CURRENT'))).equals(await readFile(join(snapshot,'CURRENT'))))return null;
    database=new ClassicLevel(snapshot,{keyEncoding:'buffer',valueEncoding:'buffer',createIfMissing:false});
    await database.open();
    const key=Buffer.concat([Buffer.from('_'+origin+'\0'),Buffer.from([1]),Buffer.from('codexer.web.relay.v1control')]);
    const bytes=await database.get(key); if(!bytes?.length)return null;
    const value=JSON.parse(bytes.subarray(1).toString(bytes[0]===0?'utf16le':'latin1'));
    if(typeof value.url!=='string'||new URL(value.url).origin!==origin||typeof value.session!=='string'||!value.session||value.session.length>16000)return null;
    return {url:origin,session:value.session};
  } catch {return null;}
  finally {await database?.close().catch(()=>{});await rm(snapshot,{recursive:true,force:true});}
}
