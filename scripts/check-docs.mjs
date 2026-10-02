import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
async function walk(directory) { const entries=await readdir(directory,{withFileTypes:true}); const result=[];for(const item of entries){const path=resolve(directory,item.name);if(item.isDirectory())result.push(...await walk(path));else if(item.name.endsWith('.md'))result.push(path);}return result; }
const files=[resolve('README.md'),...await walk('docs')];
for(const name of ['mobile','web','desktop','pc-agent','admin','relay'])files.push(resolve('apps',name,'README.md'));
const errors=[];
for(const file of files){const text=await readFile(file,'utf8');
  for(const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){let target=match[1].split(/\s+"/)[0];if(/^(https?:|mailto:|#)/.test(target))continue;target=decodeURIComponent(target.split('#')[0]);if(!target)continue;try{await access(resolve(dirname(file),target));}catch{errors.push(relative('.',file)+': missing '+target);}}
  for(const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)){const ip=match[0];if(!/^(127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip)&&ip!=='0.0.0.0')errors.push(relative('.',file)+': non-example IPv4');}
  for(const match of text.matchAll(/https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/bunnya33\/([^\s/`)]+)/g)){if(!['codexer','codexer.git'].includes(match[1]))errors.push(relative('.',file)+': unexpected repository URL');}
}
for(const required of ['architecture','server-install','server-update','pc-setup','mobile','admin','relay','operations','security','release','new-repository','validation','cleanup']){const index=await readFile('docs/README.md','utf8');if(!index.includes(`(${required}.md)`))errors.push('Index missing '+required);}
if(errors.length)throw new Error(errors.join('\n')); console.log(`${files.length} documents: links, index and example IPv4 checked.`);
