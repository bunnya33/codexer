import {spawn, execFileSync} from 'node:child_process';
import {mkdir, writeFile, readFile, access} from 'node:fs/promises';
import {randomUUID, createCipheriv, randomBytes} from 'node:crypto';
import {resolve, join} from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const executable = process.env.CODEXER_QT_AGENT_EXE || join(root, 'apps/agent-qt/stage/Codexer Agent.exe');
const directory = join(root, '.local/qt-agent-acceptance', new Date().toISOString().replace(/[:.]/g, '-')); await mkdir(directory, {recursive: true});
const version = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
function protect(value) {
  const text = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'], {input: value.toString('base64'), encoding: 'utf8', windowsHide: true});
  return Buffer.from(text.trim(), 'base64');
}
async function waitFile(path, child) {
  for (let n = 0; n < 200; n++) {
    try {return JSON.parse(await readFile(path, 'utf8'));} catch {}
    if (child.exitCode !== null) throw new Error('Agent exited before acceptance report: ' + child.exitCode);
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Agent report timeout');
}
const results = [];
for (const kind of ['fresh', 'native-credentials', 'electron-v10']) {
  const profile = join(directory, kind); await mkdir(profile);
  const settings = {relayUrl: 'https://relay.example.test', username: 'synthetic', deviceName: 'Qt Acceptance PC', installationId: randomUUID(), codexHome: join(profile, 'codex'), codexBinary: '', projectParents: [], runtime: 'auto', autoConnect: false, openAtLogin: false, minimizeToTray: true, allowHttp: false};
  const credentials = {relayUrl: settings.relayUrl, username: settings.username, installationId: settings.installationId, deviceId: randomUUID(), session: 'synthetic-session-never-transmitted', expiresAt: 8640000000000000};
  await writeFile(join(profile, 'settings.json'), JSON.stringify(settings));
  if (kind === 'native-credentials') await writeFile(join(profile, 'session.native.enc'), protect(Buffer.from(JSON.stringify(credentials))));
  if (kind === 'electron-v10') {
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([Buffer.from('v10'), iv, cipher.update(JSON.stringify(credentials)), cipher.final(), cipher.getAuthTag()]);
    await writeFile(join(profile, 'session.enc'), bytes);
    await writeFile(join(profile, 'Local State'), JSON.stringify({os_crypt: {encrypted_key: Buffer.concat([Buffer.from('DPAPI'), protect(key)]).toString('base64')}}));
  }
  const report = join(profile, 'acceptance.json');
  const env = {...process.env, CODEXER_USER_DATA_DIR: profile, CODEXER_QT_SMOKE_REPORT: report, CODEXER_QT_SMOKE_HOLD_MS: process.env.CODEXER_QT_SMOKE_HOLD_MS || (/Portable/i.test(executable) ? '20000' : '5000')};
  const child = spawn(executable, ['--smoke-test'], {env, windowsHide: true, stdio: 'ignore'});
  try {
    const result = await waitFile(report, child); assert(result.ok); assert(result.vaultRoundTrip); assert.equal(result.version, version); assert.equal(result.tabs, 5);
    assert.equal(result.installationId, settings.installationId); assert.equal(result.loggedIn, kind !== 'fresh');
    const memory = JSON.parse(execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$p=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${result.processId} -or $_.ProcessId -eq ${result.backendPid} }; @($p | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize) | ConvertTo-Json -Compress`], {encoding: 'utf8', windowsHide: true}));
    result.memory = memory; result.workingSetBytes = memory.reduce((sum, entry) => sum + Number(entry.WorkingSetSize), 0);
    assert.equal(memory.length, 2); assert(!JSON.stringify(result).includes(credentials.session));
    const second = spawn(executable, ['--background'], {env, windowsHide: true, stdio: 'ignore'});
    assert.equal(await new Promise(done => second.once('exit', done)), 0); assert.equal(child.exitCode, null);
    result.singleInstance = true;
    if (kind === 'electron-v10') {await access(join(profile, 'session.native.enc')); assert((await readFile(join(profile, 'session.enc'))).subarray(0, 3).toString() === 'v10'); result.encryptedMigration = true;}
    assert.equal(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).installationId, settings.installationId);
    await new Promise((done, fail) => {if (child.exitCode !== null) return child.exitCode === 0 ? done() : fail(new Error('Agent exit')); child.once('exit', code => code === 0 ? done() : fail(new Error('Agent shutdown ' + code)));});
    results.push({kind, ...result}); console.log(JSON.stringify({kind, ok: result.ok, loggedIn: result.loggedIn, workingSetMiB: Math.round(result.workingSetBytes / 1048576), singleInstance: true}));
  } finally {if (child.exitCode === null) child.kill();}
}
await writeFile(join(directory, 'results.json'), JSON.stringify({version, results}, null, 2));
await writeFile(join(root, '.local/qt-agent-acceptance-latest.json'), JSON.stringify({directory, version, results}, null, 2));
console.log('Qt Agent acceptance passed: ' + directory);
