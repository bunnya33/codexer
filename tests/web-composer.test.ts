import { beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

let javascript = '';
beforeAll(async () => {
  const result = await build({ stdin: {contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {ComposerInput} from './apps/mobile/src/composer.web';
    const root=createRoot(document.getElementById('root'));
    window.renderDraft=value=>flushSync(()=>root.render(<ComposerInput accessibilityLabel="消息内容" value={value} multiline imagesEnabled={false} onImages={()=>{}} onImageError={()=>{}} style={{fontSize:16,lineHeight:23,paddingHorizontal:4,paddingVertical:9}}/>));
    window.renderDraft('');
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',resolveExtensions:['.web.tsx','.web.ts','.tsx','.ts','.js','.json'],nodePaths:[resolve('apps/mobile/node_modules')],alias:{'react-native':'react-native-web'},define:{'process.env.NODE_ENV':'"production"',__DEV__:'false',global:'globalThis'}});
  javascript = result.outputFiles[0]!.text;
});

it('grows on soft wraps and composition, follows long drafts, and shrinks without collapsing the focused editor', async () => {
  const heightWrites: string[] = [];
  const dom = new JSDOM('<div id="root"></div>', {runScripts:'dangerously',pretendToBeVisual:true,beforeParse(window) {
    Object.assign(window,{matchMedia:()=>({matches:false,addListener(){},removeListener(){}}),ResizeObserver:class {observe(){}unobserve(){}disconnect(){}}});
    Object.defineProperty(window,'innerHeight',{value:844});
    window.HTMLTextAreaElement.prototype.getBoundingClientRect=()=>({width:168,height:42,x:0,y:0,top:0,left:0,right:168,bottom:42,toJSON(){}});
    // JSDOM has no layout engine; supply wrapping metrics at the actual field width.
    Object.defineProperty(window.HTMLTextAreaElement.prototype,'scrollHeight',{get(){return this.value.split('\n').reduce((sum:number,line:string)=>sum+Math.max(1,Math.ceil(line.length/20)),0)*23+18;}});
    const height=Object.getOwnPropertyDescriptor(window.CSSStyleDeclaration.prototype,'height')!;
    Object.defineProperty(window.CSSStyleDeclaration.prototype,'height',{...height,set(value:string){
      const active=window.document.activeElement as HTMLTextAreaElement|null;
      if(active?.getAttribute('aria-label')==='消息内容'&&active.style===this)heightWrites.push(value);
      height.set!.call(this,value);
    }});
  }});
  Object.defineProperties(dom.window.document.documentElement,{clientWidth:{value:390},clientHeight:{value:844}});
  try {
    dom.window.eval(javascript);
    const app=dom.window as unknown as {renderDraft:(text:string)=>void};
    const field=dom.window.document.querySelector('[aria-label="消息内容"]') as HTMLTextAreaElement;
    field.focus();
    app.renderDraft('中'.repeat(30));
    expect(field.style.height).toBe('64px');
    app.renderDraft('第一行\n第二行\n第三行');
    expect(field.style.height).toBe('87px');
    app.renderDraft('一行\n'.repeat(30));
    field.setSelectionRange(field.value.length,field.value.length);
    field.dispatchEvent(new dom.window.Event('compositionend',{bubbles:true}));
    expect(field.style.height).toBe('211px');
    expect(field.style.overflowY).toBe('auto');
    expect(field.scrollTop).toBe(field.scrollHeight);
    field.setSelectionRange(3,3);field.scrollTop=47;
    field.dispatchEvent(new dom.window.Event('compositionend',{bubbles:true}));
    await new Promise(resolve=>dom.window.requestAnimationFrame(resolve));
    expect(field.selectionStart).toBe(3);expect(field.scrollTop).toBe(47);
    app.renderDraft('短句');expect(field.style.height).toBe('42px');
    app.renderDraft('');expect(field.style.height).toBe('42px');
    expect(heightWrites).not.toContain('0px');
    expect(dom.window.document.activeElement).toBe(field);
    expect(dom.window.document.querySelectorAll('textarea')).toHaveLength(1);
  } finally {dom.window.close();}
});
