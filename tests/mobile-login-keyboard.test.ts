import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let script = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{Login}from'./apps/mobile/src/login';
    const root=createRoot(document.getElementById('root'));
    window.edit=(label,value)=>flushSync(()=>window.fields[label].onChangeText(value));
    window.focusField=label=>flushSync(()=>window.fields[label].onFocus());
    window.keyboard=(name)=>flushSync(()=>{for(const f of window.listeners[name]??[])f()});
    window.layout=()=>window.scrollLayout();window.stop=()=>flushSync(()=>root.unmount());
    flushSync(()=>root.render(<Login connect={()=>{}} busy={false} error=""/>));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'native-login-fixture', setup(builder) {
      builder.onResolve({ filter: /^(react-native|react-native-safe-area-context|expo-status-bar|lucide-react-native|\.\/styles|\.\/runtime|\.\/download-library)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: {
        'react-native': `import React,{forwardRef,useImperativeHandle}from'react';
          export const Platform={get OS(){return window.platform}};
          export const Keyboard={isVisible:()=>false,addListener:(name,fn)=>{(window.listeners[name]??=[]).push(fn);return{remove(){window.listeners[name]=window.listeners[name].filter(f=>f!==fn)}}}};
          export const View=({children})=><div>{children}</div>;export const Text=({children})=><span>{children}</span>;
          export const Image=()=>null;export const ActivityIndicator=()=>null;
          export const Pressable=({children,onPress,disabled})=><button disabled={disabled} onClick={onPress}>{children}</button>;
          export const KeyboardAvoidingView=({children,behavior})=><div data-behavior={behavior}>{children}</div>;
          export const ScrollView=forwardRef((p,ref)=>{window.scrollLayout=p.onLayout;useImperativeHandle(ref,()=>({scrollResponderScrollNativeHandleToKeyboard:(input,gap,preventNegative)=>window.scrolls.push({label:input.label,gap,preventNegative})}));return <div data-scroll="true" data-grow={p.contentContainerStyle[1].flexGrow} data-taps={p.keyboardShouldPersistTaps}>{p.children}</div>});
          export const TextInput=forwardRef((p,ref)=>{window.fields[p.accessibilityLabel]=p;useImperativeHandle(ref,()=>({label:p.accessibilityLabel}));return <input aria-label={p.accessibilityLabel} value={p.value} readOnly type={p.secureTextEntry?'password':'text'}/>});`,
        'react-native-safe-area-context': 'import React from "react";export const SafeAreaView=({children})=><div>{children}</div>;',
        'expo-status-bar': 'export const StatusBar=()=>null;',
        'lucide-react-native': 'export const Terminal=()=>null;',
        './styles': 'export const useTheme=()=>({c:{},s:{},theme:{dark:false}});',
        './runtime': 'export const defaultRelayUrl=()=>"";',
        './download-library': 'export const DownloadLibraryButton=()=>null;',
      }[args.path]! }));
    } }] }); script = result.outputFiles[0]!.text;
});
function fixture(platform: string) {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', beforeParse(w) { Object.assign(w, { platform, listeners: {}, fields: {}, scrolls: [] }); } });
  dom.window.eval(script);
  const app = dom.window as unknown as { edit(label: string, value: string): void; focusField(label: string): void; keyboard(name: string): void; layout(): void; stop(): void; scrolls: { label: string; gap: number; preventNegative: boolean }[]; listeners: Record<string, unknown[]> };
  return { dom, app, close() { app.stop(); dom.window.close(); } };
}
it.each(['ios', 'android'])('reveals the focused %s login field after keyboard opening and viewport layout changes without losing text', async platform => {
  const f = fixture(platform);
  try {
    f.app.edit('服务器地址', 'https://relay.test'); f.app.edit('账号', 'user'); f.app.edit('密码', 'private-draft');
    f.app.focusField('密码'); expect(f.app.scrolls).toEqual([]);
    f.app.keyboard('keyboardDidShow'); expect(f.app.scrolls.at(-1)).toEqual({ label: '密码', gap: 20, preventNegative: true });
    f.app.focusField('账号'); f.app.layout(); expect(f.app.scrolls.at(-1)?.label).toBe('账号');
    expect(f.dom.window.document.querySelector<HTMLInputElement>('[aria-label="密码"]')!.value).toBe('private-draft');
    expect(f.dom.window.document.querySelector('[data-scroll]')?.getAttribute('data-grow')).toBe('1');
    expect(f.dom.window.document.querySelector('[data-scroll]')?.getAttribute('data-taps')).toBe('handled');
    expect(f.dom.window.document.querySelector('[data-behavior]')?.getAttribute('data-behavior')).toBe(platform === 'ios' ? 'padding' : undefined);
    f.app.keyboard('keyboardDidHide'); const count = f.app.scrolls.length; f.app.layout(); expect(f.app.scrolls).toHaveLength(count);
  } finally { f.close(); }
  expect(Object.values(f.app.listeners).flat()).toEqual([]);
});
