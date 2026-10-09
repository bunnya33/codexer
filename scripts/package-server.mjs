import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const {version}=JSON.parse(await readFile('package.json','utf8'));
for(const path of ['dist/apps/relay/src/main.js','apps/web/dist/index.html','apps/admin/dist/index.html'])await readFile(path);
const staging=resolve('.local/server-package');
await rm(staging,{recursive:true,force:true}); await mkdir(resolve(staging,'codexer'),{recursive:true});
// Explicit allowlist: no Git history, local configuration, server addresses or credentials.
const serverScripts=['install-config','install-health','print-service-unit','server-config','server-menu','server-service','server-updater'];
const paths=['package.json','package-lock.json','install.sh','bootstrap.sh','README.md','docs','dist/apps/relay','dist/packages/protocol','dist/packages/shared',...serverScripts.map(name=>`dist/scripts/${name}.js`),'infra/Dockerfile','infra/compose.yaml','infra/Caddyfile','infra/.env.example','apps/web/dist','apps/admin/dist','apps/admin/package.json','apps/mobile/package.json','apps/desktop/package.json',...['web','admin','mobile','desktop','pc-agent','relay'].map(name=>`apps/${name}/README.md`)];
paths.push('apps/control-desktop/package.json','apps/control-desktop/README.md');
for(const path of paths)await cp(resolve(path),resolve(staging,'codexer',path),{recursive:true,filter: source => !source.replaceAll('\\','/').includes('/docs/') || source.endsWith('.md')});
await writeFile(resolve(staging,'codexer/server-bundle.json'),JSON.stringify({version,kind:'codexer-server-bundle',builtAt:new Date().toISOString()}));
await mkdir('release',{recursive:true}); const archive=resolve(`release/codexer-server-${version}.tar.gz`);
// GNU tar and bsdtar otherwise choose different long-name extensions.
const result=spawnSync('tar',['--format=pax','-czf',archive,'-C',staging,'codexer'],{stdio:'inherit'});if(result.status!==0)throw new Error('archive-failed');
const hash=createHash('sha256').update(await readFile(archive)).digest('hex');await writeFile(archive+'.sha256',hash+'  '+archive.split(/[\\/]/).at(-1)+'\n');
console.log(archive);
