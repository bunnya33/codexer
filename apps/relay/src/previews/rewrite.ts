/** Keep local app resources below the scoped preview URL, including Vite ESM imports. */
export function rewritePreviewContent(
  body: string,
  contentType: string,
  prefix: string,
  origin: string,
  path = "/",
): string {
  const map = (url: string) => {
    if (url.startsWith(prefix)) return url;
    if (url.startsWith(origin + "/")) return prefix + url.slice(origin.length + 1);
    return url.startsWith("/") && !url.startsWith("//") ? prefix + url.slice(1) : url;
  };
  const css = (source: string) =>
    source.replace(
      /url\(\s*(['"]?)(\/[^)'"\s]+)\1\s*\)/g,
      (_match, quote: string, path: string) => `url(${quote}${map(path)}${quote})`,
    );
  const js = (source: string) =>
    source
      .replace(
        /(\b(?:from|import)\s*|\bimport\s*\(\s*)(['"])(\/[^'"\n]*)\2/g,
        (_match, lead: string, quote: string, path: string) => lead + quote + map(path) + quote,
      )
      .replace(
        /(\b(?:fetch|Worker)\s*\(\s*|\bnew\s+URL\s*\(\s*)(['"])(\/[^'"\n]*)\2/g,
        (_match, lead: string, quote: string, path: string) => lead + quote + map(path) + quote,
      );
  if (/javascript|ecmascript/.test(contentType)) return js(body);
  if (/text\/css/.test(contentType)) return css(body);
  if (!/text\/html/.test(contentType)) return body;
  const escapedPrefix = JSON.stringify(prefix).replaceAll("<", "\\u003c");
  const escapedOrigin = JSON.stringify(origin).replaceAll("<", "\\u003c");
  const escapedPath = JSON.stringify(path).replaceAll("<", "\\u003c");
  const base = (prefix + path.slice(1))
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  const bootstrap = `<base href="${base}"><script>(()=>{
    const prefix=${escapedPrefix},origin=${escapedOrigin},page=new URL(${escapedPath},origin);
    window.__CODEXER_PREVIEW_BASE__=prefix;
    const map=value=>{
      try{
        const u=new URL(String(value),page);
        const local=u.origin===origin||u.origin===location.origin;
        if(!local||u.pathname.startsWith(prefix))return value;
        return prefix+u.pathname.slice(1)+u.search+u.hash;
      }catch{return value}
    };
    const fetchOriginal=window.fetch;
    window.fetch=(value,options)=>fetchOriginal(value instanceof Request?new Request(new URL(map(value.url),location.href),value):map(value),options);
    const open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,map(url),...rest)};
    const WS=window.WebSocket;
    window.WebSocket=class extends WS{
      constructor(url,protocols){
        const u=new URL(url,page);
        const local=u.origin.replace(/^ws/,'http')===origin||u.host===location.host;
        const proxied=u.pathname.startsWith(prefix);
        const socket=proxied&&u.pathname===prefix+'__socket';
        const path=(proxied?'/'+u.pathname.slice(prefix.length):u.pathname)+u.search;
        super(local&&!socket?location.origin.replace(/^http/,'ws')+prefix+'__socket?path='+encodeURIComponent(path):url,protocols);
      }
    };
    const originalPush=history.pushState.bind(history),originalReplace=history.replaceState.bind(history);
    history.pushState=(s,t,u)=>originalPush(s,t,u==null?u:map(u));
    history.replaceState=(s,t,u)=>originalReplace(s,t,u==null?u:map(u));
  })();</script>`;
  body = body.replace(
    /(\b(?:src|href|action|poster)\s*=\s*)(['"])(\/[^'"]*|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])[^'"]*)\2/gi,
    (_match, lead: string, quote: string, path: string) => lead + quote + map(path) + quote,
  );
  body = body.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (_match, attrs: string, script: string) => `<script${attrs}>${js(script)}</script>`,
  );
  body = css(body);
  return /<head(?:\s[^>]*)?>/i.test(body)
    ? body.replace(/<head(?:\s[^>]*)?>/i, (match) => match + bootstrap)
    : bootstrap + body;
}
