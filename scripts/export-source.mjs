import { readdir, lstat, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const root=resolve('.'),directory=resolve('release',`codexer-source-${version}`);
if(dirname(directory)!==resolve('release'))throw new Error('invalid-export-directory');
await rm(directory,{recursive:true,force:true}); await mkdir(directory,{recursive:true});
const excluded=new Set(['node_modules','dist','release','.git','.local','.expo','output','coverage','.vite']);
const files=[];
async function collect(path){const info=await lstat(path);if(info.isSymbolicLink())throw new Error('source-symlink-not-allowed');const name=path.split(/[\\/]/).at(-1);if(excluded.has(name)||(name.startsWith('.env')&&name!=='.env.example'))return;
  if(info.isDirectory()){for(const item of await readdir(path))await collect(resolve(path,item));}
  else {const rel=relative(root,path).replaceAll('\\','/');if(rel.startsWith('docs/')&&!rel.endsWith('.md'))return;files.push(rel);}
}
for(const path of ['apps','packages','scripts','tests','docs','infra','.github']){try{await collect(resolve(path));}catch(error){if(error.code!=='ENOENT')throw error;}}
for(const file of ['README.md','package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vitest.config.ts','.gitignore','.gitattributes','.dockerignore','install.sh','bootstrap.sh'])files.push(file);
for(const file of files){const target=resolve(directory,file);await mkdir(dirname(target),{recursive:true});await cp(resolve(file),target);}
await writeFile(resolve('release',`codexer-source-${version}.files.txt`),files.sort().join('\n')+'\n');
const archive=directory+'.tar.gz',result=spawnSync('tar',['-czf',archive,'-C',resolve('release'),`codexer-source-${version}`],{stdio:'inherit'});if(result.status!==0)throw new Error('archive-failed');
await writeFile(archive+'.sha256',createHash('sha256').update(await readFile(archive)).digest('hex')+'  '+archive.split(/[\\/]/).at(-1)+'\n');
console.log(`Exported ${files.length} files to ${directory}; no Git initialization or upload.`);
