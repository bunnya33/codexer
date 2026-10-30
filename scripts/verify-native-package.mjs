import {execFileSync} from 'node:child_process';
import {readFile,mkdir,readdir,writeFile} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..');
const {version}=JSON.parse(await readFile(join(root,'apps/desktop/package.json'),'utf8'));
const directory=join(root,'.local/native-package-verification',version,Date.now().toString());await mkdir(directory,{recursive:true});
const seven=join(root,'node_modules/electron-winstaller/vendor/7z-x64.exe');
async function walk(path) {const files=[];for(const item of await readdir(path,{withFileTypes:true})){const target=join(path,item.name);files.push(...(item.isDirectory()?await walk(target):[target]));}return files;}
const installer=join(root,`apps/agent-qt/release/Codexer-Agent-Qt-Setup-${version}-x64.exe`);
execFileSync(seven,['x','-y',installer,'-o'+join(directory,'outer')],{windowsHide:true,stdio:'ignore'});
const payload=(await walk(join(directory,'outer'))).find(path=>path.endsWith('app-64.7z'));assert(payload);
const extracted=join(directory,'application');execFileSync(seven,['x','-y',payload,'-o'+extracted],{windowsHide:true,stdio:'ignore'});
const files=await walk(extracted);assert(!files.some(path=>/(?:^|[\\/])(?:node\.exe|agent\.cjs|app\.asar|chrome_elf\.dll|icudtl\.dat|libEGL\.dll|.*v8.*\.dll)$/i.test(path)));
const stage=join(root,'apps/agent-qt/stage');const entries=[];
for(const path of await walk(stage)) {
 const name=relative(stage,path);const source=await readFile(path),packed=await readFile(join(extracted,name));assert(source.equals(packed),name);
 entries.push({name,bytes:packed.length,sha256:createHash('sha256').update(packed).digest('hex')});
}
for(const name of [`Codexer-Agent-Qt-Setup-${version}-x64.exe`,`Codexer-Agent-Qt-Portable-${version}-x64.exe`]) {
 const path=join(root,'apps/agent-qt/release',name),digest=createHash('sha256').update(await readFile(path)).digest('hex');assert((await readFile(path+'.sha256','utf8')).startsWith(digest));
}
const info=JSON.parse(await readFile(join(extracted,'qt-build.json'),'utf8'));assert.equal(info.backend,'C++/Qt');assert.equal(info.nodeRuntime,false);assert.equal(info.javascriptRuntime,false);
const result={version,installer,extracted,files:files.length,nativePayloadMatchesStage:true,nodeRuntimeIncluded:false,javascriptRuntimeIncluded:false,electronRuntimeIncluded:false,entries};
await writeFile(join(root,'.local/native-package-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({version,files:files.length,nativePayloadMatchesStage:true,nodeRuntimeIncluded:false,javascriptRuntimeIncluded:false},null,2));
