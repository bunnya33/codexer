import { lstat, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(projectRoot, 'dist');
if (dirname(output) !== projectRoot) throw new Error('build-output-outside-project');
const entry = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('build-output-must-be-a-directory');
await rm(output, { recursive: true, force: true });
