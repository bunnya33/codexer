import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
if(process.platform!=='darwin')throw new Error('Native AppKit and vault checks require macOS.');
const root=resolve(import.meta.dirname,'..'),mac=join(root,'apps/control-native/macos');
const temporary=await mkdtemp(join(tmpdir(),'codexer-native-check-'));
function run(file,args){const result=spawnSync(file,args,{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw new Error(`${file} exited ${result.status}`);}
try{
  const common=['clang++','-std=c++20','-fobjc-arc','-fblocks','-Wno-deprecated-declarations'];
  run('xcrun',[...common,'-fsyntax-only',join(mac,'RelayDeskNative/DesktopHost.mm'),join(mac,'RelayDeskNative/NativeVault.mm')]);
  const binary=join(temporary,'vault-check');
  run('xcrun',[...common,join(mac,'test/vault.test.mm'),join(mac,'RelayDeskNative/NativeVault.mm'),'-framework','Foundation','-framework','Security','-o',binary]);
  run(binary,process.argv.length>2?process.argv.slice(2):[join(mac,'test/electron-v10.json')]);
  run('plutil',['-lint',join(mac,'RelayDeskNative.xcodeproj/project.pbxproj'),join(mac,'RelayDeskNative/Info.plist'),join(mac,'RelayDeskNative/Runtime.entitlements'),join(mac,'RelayDeskNative/NodeRuntime.entitlements')]);
  console.log('macOS system adapters compile and vault checks pass. React Native application compilation still requires full Xcode.');
}finally{await rm(temporary,{recursive:true,force:true});}
