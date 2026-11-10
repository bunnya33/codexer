import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { DeployError, loginDeployment, type DeploySession } from './server-deploy.js';

export async function startDeployLogin(options: { html: string; port?: number; onLogin: (session: DeploySession) => Promise<void>; lifetimeMs?: number }) {
  const key = randomBytes(32).toString('hex'), prefix = '/' + key + '/';
  let origin = '', busy = false;
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'local-origin-required' });
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'self'");
    if (req.method === 'GET' && req.url === prefix) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(options.html); return;
    }
    if (req.method !== 'POST' || req.url !== prefix + 'login') return json(404, { error: 'not-found' });
    if (!String(req.headers['content-type']).startsWith('application/json')) return json(400, { error: 'json-required' });
    if (busy) return json(409, { error: 'login-in-progress' });
    busy = true;
    try {
      const body = await loginBody(req);
      const session = await loginDeployment(String(body.url ?? ''), String(body.username ?? ''), String(body.password ?? ''), body.allowHttp === true);
      await options.onLogin(session);
      json(200, { saved: true, url: session.url, username: session.username, expiresAt: session.expiresAt });
    } catch (error) { json(error instanceof DeployError && error.status === 401 ? 401 : 400, { error: error instanceof DeployError ? error.code : 'login-or-save-failed' }); }
    finally { busy = false; }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolveListen); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('login-listen-failed');
  origin = `http://127.0.0.1:${address.port}`;
  const close = () => { clearTimeout(timer); server.close(); server.closeIdleConnections(); };
  const timer = setTimeout(close, options.lifetimeMs ?? 10 * 60000);
  return { url: origin + prefix, close };
}
async function loginBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new DeployError('login-request-too-large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeployError('invalid-login');
  return value;
}
