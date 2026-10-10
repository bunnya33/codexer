import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileRegistry } from '../packages/codex-adapter/src/files.js';
import { PreviewRegistry } from '../packages/codex-adapter/src/previews.js';
import { localPreviewUrl, previewControls, previewFeedback, previewReferences, restoredControlValue, splitPreviewContent, widgetState } from '../packages/client-shared/src/previews.js';
import { buildPreviewDocument, nativePreviewShell } from '../packages/client-shared/src/preview-runtime.js';
import { rewritePreviewContent } from '../apps/relay/src/previews/rewrite.js';

it('recognizes inline visualizations, HTML citations and loopback URLs while preserving code and malformed markers', () => {
  const marker = 'visualize{"path":"/tmp/dashboard.html","title":"概览","mode":"wide"}';
  const source = `前文\n${marker}\n[网页](</tmp/中文 page.html>)\nhttp://127.0.0.1:5173/settings?x=1\n后文`;
  expect(previewReferences(source)).toEqual([
    {kind:'html',source:'/tmp/dashboard.html',title:'概览',wide:true},
    {kind:'html',source:'/tmp/中文 page.html',title:'网页'},
    {kind:'server',source:'http://127.0.0.1:5173/settings?x=1',title:'本地网页预览'},
  ]);
  expect(splitPreviewContent(source).filter(part=>part.kind==='text').map(part=>part.text).join('')).toContain('后文');
  for (const text of [`\`${marker}\``, `\`\`\`text\n${marker}\nhttp://localhost:3000\n\`\`\``, 'visualize{"path":', 'visualize{"path":"/secret.txt"}', 'http://localhost.evil.test', 'http://127.0.0.10:3000', '[外部](http://localhost.evil.test/a)']) expect(previewReferences(text)).toEqual([]);
  expect(previewReferences('http://[::1]:8080/test')[0]?.source).toBe('http://[::1]:8080/test');
  for (const url of ['http://user:password@localhost:3000','http://192.168.1.2:3000','file:///tmp/page.html','http://localtest.me','http://2130706433:3000']) expect(localPreviewUrl(url)).toBeNull();
});

it('reads visualization references through the existing file channel without granting other threads arbitrary paths', async () => {
  const directory = await mkdtemp(join(tmpdir(),'codexer-inline-preview-'));
  try {
    const path = join(directory,'dashboard.html'); await writeFile(path,'<button>点击</button>');
    const registry = new FileRegistry();
    registry.observeTurn('a',{items:[{id:'message',type:'agentMessage',text:`visualize${JSON.stringify({path})}`,truncated:false}]});
    expect(await registry.read('a',path)).toMatchObject({name:'dashboard.html'});
    await expect(registry.read('b',path)).rejects.toThrow('file-not-in-thread');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

it('keeps the proxy on an observed loopback origin and rejects path escapes and unobserved ports', () => {
  const registry = new PreviewRegistry();
  registry.observeTurn('a',{items:[{id:'tool',type:'commandExecution',output:'Local: http://localhost:5173/',truncated:false}]});
  expect(registry.target('a','http://localhost:5173','/api?q=hello').href).toBe('http://127.0.0.1:5173/api?q=hello');
  for (const path of ['//example.com/private','/\\example.com/private','http://example.com','/bad\npath']) expect(()=>registry.target('a','http://localhost:5173',path)).toThrow();
  expect(()=>registry.target('b','http://localhost:5173','/')).toThrow('preview-not-in-thread');
  expect(()=>registry.target('a','http://localhost:8787','/')).toThrow('preview-not-in-thread');
});

it('bounds state and controls and includes only model-visible selections in explicit feedback', () => {
  const state = widgetState({modelContent:{channel:'ads'},privateContent:{private:'must-not-be-sent'}})!;
  expect(widgetState({modelContent:'x'.repeat(17000)})).toBeNull();
  const controls = previewControls([{id:'a',group:'Dashboard',label:'圆角',kind:'slider',value:12,initial:8,min:0,max:30,step:1},{id:'bad',group:'x',label:'x',kind:'select',value:'a',initial:'a',options:'broken'}]);
  expect(controls).toHaveLength(1);
  const prompt = previewFeedback({kind:'html',source:'/tmp/dash.html',title:'概览'},'改成紧凑布局',state,controls);
  expect(prompt).toContain('改成紧凑布局'); expect(prompt).toContain('ads'); expect(prompt).toContain('"after":12'); expect(prompt).not.toContain('must-not-be-sent');
});

it('rewrites app assets and Vite imports without changing router path literals or external imports', () => {
  const prefix='/v1/previews/'+'a'.repeat(64)+'/';
  const html=rewritePreviewContent('<html><head></head><body><script type="module" src="/@vite/client"></script><img src="/logo.svg"><a href="/settings">设置</a></body></html>','text/html',prefix,'http://localhost:5173');
  expect(html).toContain(`src="${prefix}@vite/client"`); expect(html).toContain(`href="${prefix}settings"`); expect(html).toContain('__socket'); expect(html).toContain('XMLHttpRequest');
  const js=rewritePreviewContent('import "/@vite/client"; export {x} from "/src/x.ts"; const route="/settings"; import "https://example.com/x.js";','application/javascript',prefix,'http://localhost:5173');
  expect(js).toContain(prefix+'src/x.ts'); expect(js).toContain('route="/settings"'); expect(js).toContain('https://example.com/x.js');
  expect(rewritePreviewContent('a{background:url(/logo.svg)}','text/css',prefix,'http://localhost:5173')).toContain(prefix+'logo.svg');
});

it('restores saved Tweak values within updated bounds and drops removed options', () => {
  const slider = previewControls([{id:'radius',group:'Layout',label:'圆角',kind:'slider',value:8,initial:8,min:0,max:20}])[0]!;
  expect(restoredControlValue(slider, 50)).toBe(20);
  expect(restoredControlValue(slider, -1)).toBe(0);
  expect(restoredControlValue(slider, '20')).toBeUndefined();
  const select = previewControls([{id:'layout',group:'Layout',label:'布局',kind:'select',value:'grid',initial:'grid',options:[{label:'网格',value:'grid'}]}])[0]!;
  expect(restoredControlValue(select, 'grid')).toBe('grid');
  expect(restoredControlValue(select, 'removed')).toBeUndefined();
});

it('builds sandboxed native and web documents without leaking channel text into executable markup', () => {
  const html=buildPreviewDocument('<div>内容</div>','</script><script>bad()</script>',null);
  expect(html).toContain("frame-src 'none'"); expect(html).toContain("base-uri 'none'"); expect(html).not.toContain('<script>bad()');
  const shell=nativePreviewShell(html,'safe');
  expect(shell).toContain('sandbox="allow-scripts allow-forms"'); expect(shell).not.toContain('allow-same-origin'); expect(shell).toContain('e.source===frame.contentWindow');
});
