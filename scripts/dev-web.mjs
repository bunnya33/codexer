import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

let relayUrl = process.env.EXPO_PUBLIC_RELAY_URL || 'http://127.0.0.1:8787';
if (!process.env.EXPO_PUBLIC_RELAY_URL) {
  try { const services = JSON.parse(await readFile('.local/services.json', 'utf8')); if (services.relayUrl) relayUrl = services.relayUrl; } catch { /* Default local Relay. */ }
}
const cli = resolve('node_modules/expo/bin/cli');
const child = spawn(process.execPath, [cli, 'start', '--web', '--port', process.env.CODEXER_WEB_PORT || '5173'], {
  cwd: resolve('apps/mobile'), stdio: 'inherit', env: { ...process.env, EXPO_PUBLIC_RELAY_URL: relayUrl },
});
child.on('exit', code => { process.exitCode = code ?? 1; });
