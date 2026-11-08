import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('.local/mobile-interaction-preview');
await mkdir(directory, { recursive: true });
const built = await build({
  entryPoints: ['scripts/interaction-preview.web.tsx'], outdir: directory, write: false,
  bundle: true, minify: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
  nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' },
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}' },
});
const javascript = built.outputFiles.find(file => file.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
const css = built.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Codexer · 完整功能交互稿 03</title><style>html,body,#root{margin:0;width:100%;height:100%;height:100dvh}body{overflow:hidden}#root{display:flex;flex-direction:column}button,input,textarea{font:inherit}*{box-sizing:border-box}${css}</style></head><body><div id="root"></div><script>${javascript}</script></body></html>`;
await writeFile(resolve(directory, 'index.html'), html);
console.log(`Built standalone preview: ${directory}/index.html (${Buffer.byteLength(html)} bytes)`);
if (!process.argv.includes('--build')) {
  const portArgument = process.argv.find(argument => argument.startsWith('--port='));
  const port = portArgument ? Number(portArgument.slice(7)) : 4183;
  const server = createServer(async (request, response) => {
    if (request.url !== '/' && request.url !== '/index.html') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(await readFile(resolve(directory, 'index.html')));
  });
  server.listen(port, '127.0.0.1', () => console.log(`Interaction preview: http://127.0.0.1:${port}`));
}
