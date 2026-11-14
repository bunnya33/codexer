import {expect, it} from 'vitest';
import {JSDOM} from 'jsdom';
import {openPreviewDocument} from '../apps/control-native/src/preview-document';

it('loads a large desktop preview through small bridge messages and retains sandboxing and feedback', async () => {
  let dom: JSDOM | undefined;
  const receivers = new Set<(value: unknown) => void>(), messages: any[] = [];
  const value = {id:'large-preview',title:'大页面',document:'<p>测试 & " < > 😀</p>' + 'x'.repeat(4*1024*1024)};
  const bridge = {
    subscribe(_event: string, fn: (event: any) => void) {receivers.add(fn);return () => {receivers.delete(fn);};},
    async request(method: string, payload: any) {
      expect(JSON.stringify(payload).length).toBeLessThan(512*1024);
      if (method === 'preview.open') {
        expect(payload.html.length).toBeLessThan(4096);
        if (dom) return true; // Focusing an existing window must still handshake.
        dom = new JSDOM(payload.html, {runScripts:'dangerously',beforeParse(w) {
          Object.assign(w,{ReactNativeWebView:{postMessage(data: string) {
            messages.push(JSON.parse(data));
            for (const receive of receivers) receive({id:value.id,data});
          }}});
        }});
      } else dom!.window.codexerPreviewSend(payload.message);
      return true;
    },
  };
  try {
    await openPreviewDocument(bridge,value,new AbortController().signal);
    const frame = dom!.window.document.querySelector('iframe')!;
    expect(frame.srcdoc).toBe(value.document);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(receivers.size).toBe(0);
    const feedback = {channel:value.id,type:'follow-up',prompt:'调整布局'};
    dom!.window.dispatchEvent(new dom!.window.MessageEvent('message',{source:frame.contentWindow as unknown as Window,data:feedback}));
    expect(messages).toContainEqual(feedback);
    await openPreviewDocument(bridge,{...value,document:'<p>changed</p>'},new AbortController().signal);
    expect(frame.srcdoc).toBe('<p>changed</p>');
    expect(receivers.size).toBe(0);
  } finally {dom?.window.close();}
});

it('cancels a desktop shell handshake and releases subscriptions', async () => {
  const abort = new AbortController(); let subscribed = 0;
  const bridge = {
    subscribe() {subscribed++;return () => {subscribed--;};},
    async request() {queueMicrotask(() => abort.abort());return true;},
  };
  await expect(openPreviewDocument(bridge,{id:'cancel',title:'cancel',document:'text'},abort.signal)).rejects.toThrow('file-cancelled');
  expect(subscribed).toBe(0);
});
