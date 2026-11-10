import { cp, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', 'codexer-server-deploy');
await mkdir(destination, { recursive: true });
await cp(join(repository, 'skills', 'codexer-server-deploy'), destination, { recursive: true });
await writeFile(join(destination, 'workspace.json'), JSON.stringify({ repository }, null, 2) + '\n');
console.log(JSON.stringify({ installed: true, skill: 'codexer-server-deploy', path: destination, repository }));
