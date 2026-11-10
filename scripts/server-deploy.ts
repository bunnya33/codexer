import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readSecret, writeSecret } from '../packages/shared/src/secrets.js';
import { DeployClient, DeployError, deployServer, deployUrl, inspectDeployArchive } from '../packages/shared/src/server-deploy.js';
import type { DeploySession, DeployReceipt } from '../packages/shared/src/server-deploy.js';
import { startDeployLogin } from '../packages/shared/src/server-deploy-login.js';

const help = `Codexer 服务器升级工具（管理员）
  npm run server:deploy -- login [--url https://server.example.com] [--allow-http]
  npm run server:deploy -- status
  npm run server:deploy -- deploy --archive <包.tar.gz> [--checksum <包.sha256>] [--apply]
  npm run server:deploy -- logout

通用选项：--profile <名称>（默认 default） --timeout <秒>（默认 900）
deploy 默认只校验并显示计划；--apply 才上传、准备、重启并核验。
login 打开本机十分钟登录服务，密码只在登录时使用；不自动安装更新。
`;
const output = (value: unknown) => console.log(JSON.stringify(value));
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, url: { type: 'string' }, profile: { type: 'string', default: 'default' },
    'allow-http': { type: 'boolean' }, archive: { type: 'string' }, checksum: { type: 'string' },
    apply: { type: 'boolean' }, timeout: { type: 'string', default: '900' }, port: { type: 'string', default: '0' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (positionals.length !== 1 || !['login', 'status', 'deploy', 'logout'].includes(command)) throw new DeployError('invalid-command');
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(values.profile!)) throw new DeployError('invalid-profile');
  const timeout = Number(values.timeout), port = Number(values.port);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600 || !Number.isInteger(port) || port < 0 || port > 65535) throw new DeployError('invalid-timeout-or-port');
  const base = process.env.CODEXER_DEPLOY_HOME ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Codexer', 'server-deploy') : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'codexer', 'server-deploy'));
  const secretPath = resolve(base, values.profile! + '.secret'), receiptPath = resolve(base, values.profile! + '.job.json');
  const loadSession = async () => {
    let credentials: DeploySession;
    try { credentials = await readSecret<DeploySession>(secretPath); } catch { throw new DeployError('login-required-run-server-deploy-login'); }
    if (typeof credentials.session !== 'string' || !credentials.session) throw new DeployError('invalid-saved-session');
    if (values.url && deployUrl(values.url, values['allow-http']) !== credentials.url) throw new DeployError('saved-profile-server-mismatch');
    return credentials;
  };
  if (command === 'login') {
    const url = values.url ? deployUrl(values.url, values['allow-http']) : '';
    const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
    const html = (await readFile(new URL('./server-deploy-login.html', import.meta.url), 'utf8')).replace('__SERVER_URL__', escape(url)).replace('__ALLOW_HTTP__', values['allow-http'] ? 'checked' : '');
    const login = await startDeployLogin({ html, port, onLogin: async credentials => {
      await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 });
      const temporary = secretPath + '.' + randomUUID() + '.tmp';
      try { await writeSecret(temporary, credentials); await rename(temporary, secretPath); } finally { await rm(temporary, { force: true }); }
      output({ event: 'login-saved', profile: values.profile, url: credentials.url, username: credentials.username, expiresAt: credentials.expiresAt });
      setTimeout(() => login.close(), 2000).unref();
    } });
    output({ event: 'login-ready', url: login.url, expiresInSeconds: 600 });
    process.once('SIGINT', login.close); process.once('SIGTERM', login.close);
    return;
  }
  const credentials = await loadSession(), client = new DeployClient(credentials);
  if (command === 'logout') {
    try { await client.json('/v1/auth/logout', {}); }
    catch (error) { if (!(error instanceof DeployError) || error.status !== 401) throw error; }
    await rm(secretPath, { force: true }); output({ result: 'logged-out', url: credentials.url }); return;
  }
  if (command === 'status') {
    await client.assertAdmin();
    const info = await client.info();
    output({ url: client.url, username: credentials.username, currentVersion: info.currentVersion, platform: info.platform, supported: info.supported, uploadSupported: info.uploadSupported ?? false, uploading: info.uploading ?? false, job: info.job }); return;
  }
  if (!values.archive) throw new DeployError('archive-required');
  const archive = await inspectDeployArchive(values.archive, values.checksum);
  const receipt = await readFile(receiptPath, 'utf8').then(text => JSON.parse(text) as DeployReceipt).catch(() => null);
  const save = async (value: DeployReceipt) => {
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
    const temporary = receiptPath + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, receiptPath); } finally { await rm(temporary, { force: true }); }
  };
  output(await deployServer(client, archive, { apply: values.apply, receipt, save, timeoutMs: timeout * 1000, report: output }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  output({ error: error instanceof DeployError ? error.code : 'local-deploy-tool-error', ...(error instanceof DeployError && error.status ? { status: error.status } : {}) }); process.exitCode = 1;
});
