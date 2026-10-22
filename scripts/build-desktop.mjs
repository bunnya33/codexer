import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('apps/desktop');
const { version } = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
await rm(resolve(directory, 'dist'), { recursive: true, force: true });
await mkdir(resolve(directory, 'dist'), { recursive: true });
for (const entry of ['main', 'preload', 'worker']) {
  await build({ entryPoints: [resolve(directory, 'src', entry + '.ts')], outfile: resolve(directory, 'dist', entry + '.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], packages: 'bundle', sourcemap: false, define: { 'process.env.NODE_ENV': '"production"', 'process.env.CODEXER_AGENT_BUILD_VERSION': JSON.stringify(version) } });
}
await copyFile(resolve(directory, 'assets/icon.png'), resolve(directory, 'dist/icon.png'));
await viteBuild({ configFile: resolve(directory, 'vite.config.ts') });
console.log('Desktop main, preload, Agent and UI bundled.');
