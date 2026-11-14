import {nativePreviewShell} from '../../../packages/client-shared/src/preview-runtime';

type Bridge = {
  request: (method: string, value: any) => Promise<unknown>;
  subscribe: (event: string, receive: (value: any) => void) => () => void;
};
export async function openPreviewDocument(bridge: Bridge, value: {id: string; title: string; document?: string; url?: string}, signal: AbortSignal) {
  const {id, title, document = '', url} = value;
  if (signal.aborted) throw new Error('file-cancelled');
  if (url) return bridge.request('preview.open', {id, title, html: nativePreviewShell(url, id, true, true)});
  const transfer = String(Date.now()) + Math.random();
  let ready = false, accepted = false;
  let wake: (() => void) | undefined;
  const off = bridge.subscribe('previewMessage', event => {
    if (event.id !== id) return;
    try {
      const message = JSON.parse(event.data);
      if (message.channel !== id) return;
      if (message.type === 'shell-ready') ready = true;
      if (message.type === 'document-accepted' && message.transfer === transfer) accepted = true;
      wake?.();
    } catch { /* Ignore malformed messages from the isolated preview. */ }
  });
  const send = (message: unknown) => {
    if (signal.aborted) throw new Error('file-cancelled');
    return bridge.request('preview.send', {id, message});
  };
  const wait = (check: () => boolean, probe = false) => new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout); clearInterval(timer); signal.removeEventListener('abort', cancel); wake = undefined;
      error ? reject(error) : resolve();
    };
    const cancel = () => finish(new Error('file-cancelled'));
    const timeout = setTimeout(() => finish(new Error('preview-timeout')), 30000);
    const timer = setInterval(() => { if (probe) void send({type:'shell-ping'}).catch(error => finish(error)); }, 150);
    wake = () => { if (check()) finish(); };
    signal.addEventListener('abort', cancel, {once:true});
    if (signal.aborted) cancel(); else wake();
  });
  try {
    await bridge.request('preview.open', {id, title, html: nativePreviewShell('', id, false, true, true)});
    await wait(() => ready, true);
    await send({type:'document-start', transfer});
    let count = 0;
    for (let offset = 0; offset < document.length; offset += 64 * 1024) {
      await send({type:'document-chunk', transfer, index:count++, text:document.slice(offset, offset + 64 * 1024)});
    }
    await send({type:'document-end', transfer, count});
    await wait(() => accepted);
  } finally { off(); }
}
