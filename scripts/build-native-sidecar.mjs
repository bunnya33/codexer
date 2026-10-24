import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {cp,mkdir,readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const app=join(root,'apps/control-native');
const {version}=JSON.parse(await readFile(join(app,'package.json'),'utf8'));
const output=process.argv[2]?resolve(process.argv[2]):join(app,'service');
await mkdir(output,{recursive:true});
await build({nodePaths:[join(process.env.CODEXER_NATIVE_DEPENDENCIES ? resolve(process.env.CODEXER_NATIVE_DEPENDENCIES) : app,'node_modules')],entryPoints:[join(app,'src/sidecar.ts')],outfile:join(output,'sidecar.cjs'),bundle:true,external:['classic-level'],platform:'node',format:'cjs',target:'node24',logLevel:'info',define:{'process.env.CODEXER_AGENT_BUILD_VERSION':JSON.stringify(version)}});
const dependencyRoot=process.env.CODEXER_NATIVE_DEPENDENCIES ? resolve(process.env.CODEXER_NATIVE_DEPENDENCIES) : app;
const require=createRequire(join(dependencyRoot,'package.json'));
const copied=new Set();
async function dependency(name){
  if(copied.has(name))return;copied.add(name);
  const source=dirname(require.resolve(name+'/package.json'));
  const metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
  await cp(source,join(output,'node_modules',name),{recursive:true,filter:path=>{
    if(/[\\/](test|tests|benchmark|benchmarks|deps|obj|build)[\\/]/.test(path))return false;
    const match=path.replaceAll('\\','/').match(/\/prebuilds\/([^/]+)(?:\/|$)/);
    if(!match)return true;
    const [platform,architectures]=match[1].split('-');
    return platform===process.platform && architectures?.split('+').includes(process.arch);
  }});
  for(const child of Object.keys(metadata.dependencies||{}))await dependency(child);
}
await dependency('classic-level');
