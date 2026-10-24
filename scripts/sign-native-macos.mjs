import {spawn} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(import.meta.dirname,'..');
const mac=join(root,'apps/control-native/macos/RelayDeskNative');
async function run(file,args,cwd){
  await new Promise((done,fail)=>{
    const child=spawn(file,args,{cwd,stdio:'inherit'});
    child.once('error',fail);child.once('exit',code=>code===0?done():fail(new Error(`${basename(file)} exited ${code}`)));
  });
}
export async function signNativeMacProduct(product){
  if(process.platform!=='darwin')throw new Error('Native macOS signing requires macOS.');
  product=resolve(product);
  const resources=join(product,'Contents/Resources');
  const metadata=JSON.parse(await readFile(join(resources,'native-build.json'),'utf8'));
  if(metadata.ui!=='React Native macOS')throw new Error('Only a compiled React Native macOS product can be signed.');
  const identity=process.env.CODEXER_MAC_SIGN_IDENTITY||'-';
  const nodeEntitlements=join(mac,'NodeRuntime.entitlements');
  // Ad-hoc signatures have no shared Team ID. On current macOS, the native
  // host must allow its ad-hoc Hermes framework; Developer ID builds retain
  // library validation because all bundled binaries share the signing team.
  const hostEntitlements=join(mac,identity==='-'?'AdHocRuntime.entitlements':'Runtime.entitlements');
  async function signNested(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const path=join(directory,entry.name);
      if(entry.isDirectory()){
        await signNested(path);
        if(entry.name.endsWith('.framework'))await run('codesign',['--force','--sign',identity,'--options','runtime',path]);
      }else if(entry.name.endsWith('.node')||entry.name.endsWith('.dylib')||entry.name==='node'){
        await run('codesign',['--force','--sign',identity,'--options','runtime',...(entry.name==='node'?['--entitlements',nodeEntitlements]:[]),path]);
      }
    }
  }
  await signNested(join(product,'Contents'));
  await run('codesign',['--force','--sign',identity,'--options','runtime','--entitlements',hostEntitlements,product]);
  await run('codesign',['--verify','--deep','--strict',product]);
  // Exercise the signed bundled runtime, rather than a developer's Node.
  await run(join(resources,'runtime/node'),['-e',`
    const assert=require('node:assert/strict');
    const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
    const {zstdCompressSync,zstdDecompressSync}=require('node:zlib');
    const {ClassicLevel}=require('./node_modules/classic-level');
    (async()=>{
      const sample=Buffer.from('Codexer native runtime');
      assert.deepEqual(zstdDecompressSync(zstdCompressSync(sample)),sample);
      const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codexer-native-'));
      const db=new ClassicLevel(path.join(dir,'db'));
      try{await db.put('runtime','ok');assert.equal(await db.get('runtime'),'ok');}
      finally{await db.close();await fs.rm(dir,{recursive:true,force:true});}
      console.log('Signed packaged Node, Zstandard and native LevelDB passed.');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `],join(resources,'service'));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv[2])throw new Error('Pass the path of a compiled native .app bundle.');
  await signNativeMacProduct(process.argv[2]);
}
