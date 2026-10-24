import {spawn,execFileSync} from 'node:child_process';
import {access,cp,mkdir,readFile,readdir,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve,basename} from 'node:path';
import {signNativeMacProduct} from './sign-native-macos.mjs';

const root=resolve(import.meta.dirname,'..');
const app=join(root,'apps/control-native'),mac=join(app,'macos');
const {version}=JSON.parse(await readFile(join(app,'package.json'),'utf8'));
const flags=new Set(process.argv.slice(2));
if(process.platform!=='darwin'||!['arm64','x64'].includes(process.arch))throw new Error('Build the macOS native client on macOS arm64 or x64.');
if(Number(process.versions.node.split('.')[0])<24)throw new Error('Node 24+ is required.');
const env={...process.env,CODEXER_NATIVE_PLATFORM:'macos',CODEXER_NATIVE_DEPENDENCIES:mac,RCT_NEW_ARCH_ENABLED:'1',NODE_BINARY:process.execPath};
async function run(file,args,cwd=mac){await new Promise((done,fail)=>{const child=spawn(file,args,{cwd,env,stdio:'inherit'});child.once('error',fail);child.once('exit',code=>code===0?done():fail(new Error(`${basename(file)} exited ${code}`)));});}
const bundle=join(mac,'Bundle');
await access(join(mac,'node_modules/react-native-macos/package.json')).catch(()=>{throw new Error('Run npm ci --prefix apps/control-native/macos first.');});
if(!flags.has('--prepare-only')){
  try {
    const selected=execFileSync('xcodebuild',['-version'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    if(!/^Xcode\s/m.test(selected))throw new Error('not-xcode');
  } catch {
    throw new Error('需要完整 Xcode；当前仅有 Command Line Tools。安装并打开 Xcode 完成组件安装后，执行 sudo xcode-select -s /Applications/Xcode.app/Contents/Developer，再运行本命令。');
  }
}
if(!flags.has('--skip-build')){
  await run(process.execPath,[join(app,'check-types.cjs'),'--macos']);
  await mkdir(bundle,{recursive:true});
  await run(process.execPath,[join(mac,'node_modules/react-native-macos/cli.js'),'bundle','--config',join(mac,'metro.config.cjs'),'--platform','macos','--dev','false','--entry-file','index.js','--bundle-output',join(bundle,'main.jsbundle'),'--assets-dest',bundle,'--reset-cache']);
  // RN macOS generates its Apple TurboModule interfaces through the ios entry point.
  await run(process.execPath,[join(mac,'node_modules/react-native-macos/scripts/generate-codegen-artifacts.js'),'-p',mac,'-t','ios','-o',mac]);
  await run(process.execPath,[join(root,'scripts/build-native-sidecar.mjs'),join(mac,'build/service')],root);
}
if(flags.has('--prepare-only')){
  console.log('Shared React Native macOS bundle and Agent prepared; no native application has been compiled or installed.');process.exit(0);
}
await writeFile(join(mac,'.xcode.env.local'),`export NODE_BINARY=${"'"+process.execPath.replaceAll("'","'\\''")+"'"}\n`);
if(!flags.has('--skip-pods'))await run('bundle',['exec','pod','install']);
const output=join(app,'release');await mkdir(output,{recursive:true});
const modes=flags.has('--agent')?['agent']:flags.has('--control')?['control']:['agent','control'];
const artifacts=[];
const derived=join(mac,'DerivedData/native');
if(!flags.has('--skip-build'))await run('xcodebuild',['-workspace','RelayDeskNative.xcworkspace','-scheme','RelayDeskNative','-configuration','Release','-derivedDataPath',derived,`ARCHS=${process.arch==='arm64'?'arm64':'x86_64'}`,'ONLY_ACTIVE_ARCH=YES','CODE_SIGNING_ALLOWED=NO',`MARKETING_VERSION=${version}`,`CURRENT_PROJECT_VERSION=${version}`,'build']);
const built=join(derived,'Build/Products/Release/RelayDeskNative.app');
for(const mode of modes){
  const name=mode==='agent'?'Codexer':'RelayDesk';
  const stage=join(app,'stage',`${name}-${version}-macos-${process.arch}`);
  await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
  const product=join(stage,name+'.app');await cp(built,product,{recursive:true,verbatimSymlinks:true});
  const plist=join(product,'Contents/Info.plist');
  const builtVersion=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',plist],{encoding:'utf8'}).trim();
  if(builtVersion!==version)throw new Error('Native output version mismatch; rebuild without --skip-build.');
  await rename(join(product,'Contents/MacOS/RelayDeskNative'),join(product,'Contents/MacOS',name));
  for(const [key,value] of Object.entries({CFBundleExecutable:name,CFBundleName:name,CFBundleIdentifier:mode==='agent'?'com.codexer.connector':'com.codexer.control',CodexerNativeMode:mode}))await run('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist]);
  const resources=join(product,'Contents/Resources');await cp(bundle,resources,{recursive:true});await mkdir(join(resources,'runtime'),{recursive:true});
  await cp(process.execPath,join(resources,'runtime/node'));
  await cp(join(mac,'build/service'),join(resources,'service'),{recursive:true});
  await cp(join(root,'apps/desktop/assets/icon.icns'),join(resources,'AppIcon.icns'));
  const license=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(30000)});if(!license.ok)throw new Error('Cannot retrieve bundled Node license.');
  await writeFile(join(resources,'runtime/Node-LICENSE'),await license.text());
  await cp(join(app,'THIRD_PARTY_NOTICES.md'),join(resources,'THIRD_PARTY_NOTICES.md'));
  const licenses=join(resources,'licenses');await mkdir(licenses,{recursive:true});
  for(const dependency of ['react','react-native-macos','react-native-svg','lucide-react-native','zod','immer','markdown-it','markdown-it-task-lists','highlight.js','fast-text-encoding']){
    const directory=join(mac,'node_modules',dependency);
    for(const file of await readdir(directory))if(/^(licen[cs]e|notice|third.party)/i.test(file))await cp(join(directory,file),join(licenses,dependency.replaceAll('/','-')+'-'+file),{recursive:true});
  }
  await writeFile(join(resources,'native-build.json'),JSON.stringify({name,version,mode,ui:'React Native macOS',reactNativeMacOS:'0.83.0',reactNative:'0.83.10',node:process.version,architecture:process.arch,sharedSource:'apps/control-native/src'},null,2));
  await access(join(resources,'main.jsbundle'));
  const actual=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(product,'Contents/Info.plist')],{encoding:'utf8'}).trim();
  if(actual!==version)throw new Error('Native output version mismatch; rebuild without --skip-build.');
  await signNativeMacProduct(product);
  if(flags.has('--stage-only')){console.log(product);continue;}
  const prefix=`${name}-Native-${version}-${process.arch}`;
  const zip=join(output,prefix+'-mac.zip'),dmg=join(output,prefix+'.dmg');
  await run('ditto',['-c','-k','--sequesterRsrc','--keepParent',product,zip]);
  await symlink('/Applications',join(stage,'Applications')).catch(error=>{if(error.code!=='EEXIST')throw error;});
  await run('hdiutil',['create','-volname',name,'-srcfolder',stage,'-ov','-format','UDZO',dmg]);
  for(const file of [zip,dmg]){const sha256=createHash('sha256').update(await readFile(file)).digest('hex');await writeFile(file+'.sha256',sha256+'  '+basename(file)+'\n');artifacts.push({file,sha256});}
}
await writeFile(join(output,`native-macos-${version}-${process.arch}.json`),JSON.stringify({version,artifacts},null,2));
console.log(JSON.stringify({version,artifacts},null,2));
