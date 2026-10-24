import {spawn} from 'node:child_process';
import {cp,mkdir,readFile,writeFile,rm,access,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,relative} from 'node:path';
import {createRequire} from 'node:module';
const root=resolve(import.meta.dirname,'..');
const app=join(root,'apps/control-native');
const require=createRequire(import.meta.url);
const {version}=JSON.parse(await readFile(join(app,'package.json'),'utf8'));
const flags=new Set(process.argv.slice(2));
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Build on Windows x64 with Node 24+.');
if(Number(process.versions.node.split('.')[0])<24)throw new Error('Node 24+ is required.');
async function run(file,args,cwd=root){await new Promise((done,fail)=>{const child=spawn(file,args,{cwd,stdio:'inherit',windowsHide:true});child.once('error',fail);child.once('exit',code=>code===0?done():fail(new Error(`${file} exited ${code}`)));});}
if(!flags.has('--skip-build')){
  await run(process.execPath,[join(app,'check-types.cjs')],app);
  await run(process.execPath,[join(app,'node_modules/@react-native-community/cli/build/bin.js'),'autolink-windows','--sln','windows/RelayDesk.sln','--proj','windows/RelayDesk/RelayDesk.vcxproj'],app);
  let msbuild=process.env.CODEXER_MSBUILD;
  if(!msbuild){
    const vswhere=join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe');
    const {execFileSync}=await import('node:child_process');
    msbuild=execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.Component.MSBuild','-find','MSBuild/**/Bin/MSBuild.exe'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0];
  }
  if(!msbuild)throw new Error('Install Visual Studio C++ desktop tools and Windows SDK.');
  let sdk=process.env.CODEXER_WINDOWS_SDK;
  if(!sdk){
    const sdkRoot=join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Windows Kits/10');
    const versions=(await readdir(join(sdkRoot,'Include'))).filter(value=>/^10\.0\.\d+\.0$/.test(value)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
    for(const candidate of versions){
      try{await Promise.all([access(join(sdkRoot,'Include',candidate,'um/Windows.h')),access(join(sdkRoot,'Lib',candidate,'um/x64/kernel32.lib')),access(join(sdkRoot,'Lib',candidate,'ucrt/x64/ucrt.lib'))]);sdk=candidate;break;}catch{}
    }
  }
  if(!sdk)throw new Error('Install the Windows SDK desktop headers and x64 libraries, or set CODEXER_WINDOWS_SDK.');
  await run(msbuild,['windows/RelayDesk.sln','/restore','/t:RelayDesk','/p:Configuration=Release','/p:Platform=x64',`/p:PlatformToolset=${process.env.CODEXER_PLATFORM_TOOLSET||'v145'}`,`/p:WindowsTargetPlatformVersion=${sdk}`,'/p:WindowsAppSDKSelfContained=true','/p:WindowsPackageType=None','/m:4','/v:minimal','/nologo'],app);
}
const built=join(app,'windows/x64/Release');
const bundle=await readFile(join(built,'Bundle/index.windows.bundle'));
if(bundle.subarray(0,8).toString('hex')!=='c61fbc03c103191f')throw new Error('Release output must contain a compiled Hermes bundle. Rebuild without --skip-build.');
const {build,Platform,Arch}=require('electron-builder');
const output=join(app,'release');
await mkdir(output,{recursive:true});
const artifacts=[];
const modes=flags.has('--control')?['control']:flags.has('--agent')?['agent']:['control','agent'];
for(const mode of modes){
  const name=mode==='control'?'RelayDesk':'Codexer';
  const stage=join(app,'stage',`${name}-${version}`);
  if(relative(join(app,'stage'),stage).startsWith('..'))throw new Error('Invalid stage path.');
  await rm(stage,{recursive:true,force:true});
  await cp(built,stage,{recursive:true,filter:source=>{
    const part=relative(built,source).replaceAll('\\','/');
    return !/\.(pdb|exp|lib|map)$/i.test(part)&&!/^((sourcemaps|service|runtime)(\/|$))/.test(part);
  }});
  const exe=join(stage,`${name}.exe`);
  if(name!=='RelayDesk'){
    await cp(join(stage,'RelayDesk.exe'),exe);
    await rm(join(stage,'RelayDesk.exe'));
    await cp(join(stage,'RelayDesk.pri'),join(stage,`${name}.pri`));
  }
  const icon=join(root,mode==='control'?'apps/control-desktop/assets/icon.ico':'apps/desktop/assets/icon.ico');
  await cp(icon,join(stage,'icon.ico'));
  const rcedit=join(root,'node_modules/electron-winstaller/vendor/rcedit.exe');
  await access(rcedit);
  await run(rcedit,[exe,'--set-icon',icon,'--set-file-version',version,'--set-product-version',version,'--set-version-string','ProductName',name,'--set-version-string','FileDescription',`${name} · React Native for Windows`]);
  await mkdir(join(stage,'runtime'),{recursive:true});
  await cp(process.execPath,join(stage,'runtime/node.exe'));
  await run(process.execPath,[join(root,'scripts/build-native-sidecar.mjs'),join(stage,'service')]);
  await writeFile(join(stage,'native-build.json'),JSON.stringify({name,version,mode,ui:'React Native for Windows',reactNative:'0.84.1',reactNativeWindows:'0.84.0',node:process.version,architecture:'x64',selfContainedWindowsAppRuntime:true},null,2));
  await cp(join(app,'README.md'),join(stage,'README.md'));
  await cp(join(app,'VALIDATION.md'),join(stage,'VALIDATION.md'));
  await cp(join(app,'THIRD_PARTY_NOTICES.md'),join(stage,'THIRD_PARTY_NOTICES.md'));
  const licenses=join(stage,'licenses');await mkdir(licenses,{recursive:true});
  for(const dependency of ['react','react-native','react-native-windows','react-native-svg','lucide-react-native','zod','immer','markdown-it','highlight.js','fast-text-encoding']){
    const directory=join(app,'node_modules',dependency);
    for(const file of await readdir(directory))if(/^(licen[cs]e|notice|third.party)/i.test(file))await cp(join(directory,file),join(licenses,dependency.replaceAll('/','-')+'-'+file),{recursive:true});
  }
  const nodeLicense=join(dirname(process.execPath),'LICENSE');
  try{if(process.version!=='v24.11.1')throw new Error('different-node-version');await cp(join(app,'Node-LICENSE.txt'),join(licenses,'Node-LICENSE'));}catch{
    try{await cp(nodeLicense,join(licenses,'Node-LICENSE'));}catch{
    const response=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Cannot retrieve Node license.');await writeFile(join(licenses,'Node-LICENSE'),await response.text());
    }
  }
  const nuget=process.env.NUGET_PACKAGES||join(process.env.USERPROFILE,'.nuget/packages');
  const webviewVersions=await readdir(join(nuget,'microsoft.web.webview2'));
  const webview=webviewVersions.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
  await cp(join(nuget,'microsoft.web.webview2',webview,'runtimes/win-x64/native/WebView2Loader.dll'),join(stage,'WebView2Loader.dll'));
  for(const dependency of ['microsoft.windowsappsdk','microsoft.web.webview2','microsoft.reactnative','microsoft.javascript.hermes']){
    const versions=await readdir(join(nuget,dependency));
    for(const dependencyVersion of versions){const directory=join(nuget,dependency,dependencyVersion);for(const file of await readdir(directory))if(/^(licen[cs]e|notice)/i.test(file))await cp(join(directory,file),join(licenses,dependency+'-'+dependencyVersion+'-'+file));}
  }
  if(flags.has('--stage-only'))continue;
  await mkdir(join(stage,'resources'),{recursive:true});
  const files=await build({projectDir:app,prepackaged:stage,targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),publish:'never',config:{
    appId:mode==='control'?'com.codexer.control':'com.codexer.connector',productName:name,executableName:name,electronVersion:'44.5.1',
    directories:{output},artifactName:`${name}-Native-Setup-${version}-x64.exe`,npmRebuild:false,
    win:{icon,signAndEditExecutable:false,signExecutable:false,target:['nsis']},
    nsis:{oneClick:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,createStartMenuShortcut:true,runAfterFinish:false,deleteAppDataOnUninstall:false},
  }});
  for(const file of files){if(file.endsWith('.exe')){const bytes=await readFile(file);artifacts.push({name:relative(output,file),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}
}
if(artifacts.length)await writeFile(join(output,'SHA256SUMS.txt'),artifacts.map(value=>`${value.sha256}  ${value.name}`).join('\n')+'\n');
console.log(JSON.stringify({version,output,artifacts},null,2));
