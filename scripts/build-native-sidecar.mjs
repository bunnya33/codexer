import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {cp,mkdir,readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const app=join(root,'apps/control-native');
const {version}=JSON.parse(await readFile(join(app,'package.json'),'utf8'));
const output=process.argv[2]?resolve(process.argv[2]):join(app,'service');
await mkdir(output,{recursive:true});
await build({entryPoints:[join(app,'src/sidecar.ts')],outfile:join(output,'sidecar.cjs'),bundle:true,external:['classic-level'],platform:'node',format:'cjs',target:'node24',logLevel:'info',define:{'process.env.CODEXER_AGENT_BUILD_VERSION':JSON.stringify(version)}});
const require=createRequire(join(app,'package.json'));
const copied=new Set();
async function dependency(name){
  if(copied.has(name))return;copied.add(name);
  const source=dirname(require.resolve(name+'/package.json'));
  const metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
  await cp(source,join(output,'node_modules',name),{recursive:true,filter:path=>!/[\\/](test|tests|benchmark|benchmarks|deps|obj|build)[\\/]/.test(path)&&(!path.includes('prebuilds')||!/[\\/]prebuilds[\\/](?!win32-x64)/.test(path))});
  for(const child of Object.keys(metadata.dependencies||{}))await dependency(child);
}
await dependency('classic-level');
