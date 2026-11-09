// Update an already prepared short-path Expo native build copy without removing its caches.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile,realpath} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=await realpath(resolve(import.meta.dirname,'..'));
const {values}=parseArgs({options:{stage:{type:'string'}}});
if(!values.stage) throw new Error('Pass --stage <prepared Expo build copy> (see docs/android-signing.md)');
const stage=await realpath(resolve(values.stage));
assert.notEqual(stage.toLowerCase(),root.toLowerCase(),'Build copy must be separate from the main source directory');
const load=async path=>JSON.parse(await readFile(path,'utf8'));
const sourcePackage=await load(join(root,'apps/mobile/package.json'));
const sourceConfig=await load(join(root,'apps/mobile/app.json'));
const priorPackage=await load(join(stage,'apps/mobile/package.json'));
const priorConfig=await load(join(stage,'apps/mobile/app.json'));
assert.deepEqual({...sourcePackage,version:undefined},{...priorPackage,version:undefined},'Native dependencies changed: prepare dependencies and regenerate the native build copy first');
const withoutVersions=config=>({...config,expo:{...config.expo,version:undefined,android:{...config.expo.android,versionCode:undefined}}});
assert.deepEqual(withoutVersions(sourceConfig),withoutVersions(priorConfig),'Native Expo configuration changed: regenerate the native build copy first');
const version=sourcePackage.version,versionCode=sourceConfig.expo.android.versionCode;
assert.equal(version,sourceConfig.expo.version);
const gradlePath=join(stage,'apps/mobile/android/app/build.gradle');
const gradle=await readFile(gradlePath,'utf8');
assert.equal((gradle.match(/versionCode \d+/g)||[]).length,1,'Expected one native versionCode');
assert.equal((gradle.match(/versionName "[^"]+"/g)||[]).length,1,'Expected one native versionName');
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(file=>file&&(file.startsWith('apps/mobile/')||file.startsWith('packages/')||file.startsWith('scripts/')||['package.json','package-lock.json','tsconfig.json','metro.config.js','babel.config.js'].includes(file)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of files){
  const source=join(root,file),target=join(stage,file);
  await mkdir(dirname(target),{recursive:true});await copyFile(source,target);
  assert.equal(hash(await readFile(source)),hash(await readFile(target)),`Source copy mismatch: ${file}`);
}
await writeFile(gradlePath,gradle.replace(/versionCode \d+/,'versionCode '+versionCode).replace(/versionName "[^"]+"/,'versionName "'+version+'"'));
const report={files:files.length,mismatches:[],version,versionCode,nativeDependenciesUnchanged:true,nativeConfigurationUnchanged:true};
const output=join(root,'release/android-'+version);await mkdir(output,{recursive:true});
await writeFile(join(output,'source-sync.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
