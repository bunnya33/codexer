/** Only a trusted player shell is executed; filenames never become HTML. */
export function nativeAudioDocument(uri: string): string {
  const escaped = uri.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${escaped}; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:white}audio{display:block;width:100%}</style></head><body><audio controls preload="metadata" src="${escaped}"></audio><script>document.querySelector('audio').addEventListener('error',function(){window.ReactNativeWebView.postMessage('audio-error')});</script></body></html>`;
}
