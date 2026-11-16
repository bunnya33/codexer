import { beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let script = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{ConversationChromeComposer}from'./apps/mobile/src/interaction/conversation-chrome';
    const root=createRoot(document.getElementById('root')),anchor={current:null},noop=()=>{};
    window.render=text=>flushSync(()=>root.render(<ConversationChromeComposer text={text} onChangeText={noop} phase="idle" attachments={[]} onRemoveAttachment={noop} onAttachmentPress={noop} plan={false} modelLabel="6.1 Sol" effortLabel="极高" permission="ask" onSubmit={noop} onAttachments={noop} onModel={noop} onPermissions={noop} onClearPlan={noop} attachmentAnchor={anchor} modelAnchor={anchor}/>));
    window.focus=focused=>flushSync(()=>window.editor[focused?'onFocus':'onBlur']());window.stop=()=>flushSync(()=>root.unmount());
    window.render('');
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'suspended-ios-animation', setup(builder) {
      builder.onResolve({ filter: /^(react-native|lucide-react-native|\.\.\/styles|\.\.\/marquee-title|\.\.\/task-status-dot|\.\/primitives|\.\/motion|\.\/control-symbols)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: {
        'react-native': `import React,{forwardRef}from'react';export const Platform={OS:'ios'};
          export const useWindowDimensions=()=>({width:390,height:844});export const StyleSheet={create:value=>value};
          export const View=forwardRef((props,ref)=>{if(props.testID==='chrome-composer')window.composer=Object.assign({},...props.style);if(props.style?.marginLeft!==undefined)window.margins=props.style;return <div>{props.children}</div>});
          export const ScrollView=View;export const Text=({children})=><span>{children}</span>;export const Pressable=({children})=><button>{children}</button>;
          export const TextInput=props=>{window.editor=props;return <textarea value={props.value} readOnly/>};export const Image=()=>null;export const ActivityIndicator=()=>null;
          export const Animated={View,Value:class{interpolate(){return 'stalled-animation'}},timing:()=>{throw Error('iOS critical layout must not depend on an animation')}};`,
        'lucide-react-native': 'export const ArrowUp=()=>null,Check=ArrowUp,ListChecks=ArrowUp,Menu=ArrowUp,MoreHorizontal=ArrowUp,Paperclip=ArrowUp,Play=ArrowUp,Plus=ArrowUp,Square=ArrowUp,SquarePen=ArrowUp,X=ArrowUp;',
        '../styles': 'export const useTheme=()=>({c:{}});',
        '../marquee-title': 'export const MarqueeTitle=()=>null;',
        '../task-status-dot': 'export const TaskStatusDot=()=>null;',
        './primitives': 'export const ChromeButton=()=>null;',
        './motion': 'export const useInteractionMotion=()=>window.motion;',
        './control-symbols': 'export const chromePermissionLabels={ask:"询问"};export const PermissionSymbol=()=>null;',
      }[args.path]! }));
    } }] }); script = result.outputFiles[0]!.text;
});

it('reserves independent text and toolbar rows on iOS even when animations are suspended', () => {
  const errors: unknown[] = [];
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', beforeParse(w) {
    Object.assign(w, {motion:true}); w.addEventListener('error', event => errors.push(event.error));
  } });
  dom.window.eval(script);
  const app = dom.window as unknown as {motion:boolean;composer:{paddingBottom:number};margins:{marginLeft:number;marginRight:number};render(value:string):void;focus(value:boolean):void;stop():void};
  try {
    expect(app.composer.paddingBottom).toBe(4);
    app.focus(true); expect(app.composer.paddingBottom).toBe(49); expect(app.margins).toMatchObject({marginLeft:7,marginRight:7});
    app.render('第一行\n第二行，仍在输入的中文草稿');
    app.motion = false; app.render('第一行\n第二行，仍在输入的中文草稿'); app.focus(false);
    expect(app.composer.paddingBottom).toBe(49); expect(app.margins).toMatchObject({marginLeft:7,marginRight:7});
    app.motion = true; app.render('第一行\n第二行，仍在输入的中文草稿');
    expect(app.composer.paddingBottom).toBe(49);
    expect(dom.window.document.querySelector('textarea')?.value).toBe('第一行\n第二行，仍在输入的中文草稿');
    app.render(''); expect(app.composer.paddingBottom).toBe(4);
    expect(errors).toEqual([]);
  } finally { app.stop(); dom.window.close(); }
});
