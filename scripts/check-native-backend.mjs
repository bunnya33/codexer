import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join, resolve, delimiter} from 'node:path';
const root = resolve(import.meta.dirname, '..');
const qt = process.env.CODEXER_QT_ROOT || process.env.QT_ROOT_DIR || join(root, '.local/qt/6.8.3', process.platform === 'win32' ? 'msvc2022_64' : 'macos');
const env = {...process.env, PATH: join(qt, 'bin') + delimiter + process.env.PATH, QT_PLUGIN_PATH: join(qt, 'plugins')};
await mkdir(join(root, '.local'), {recursive: true});
async function run(file, args, capture = false) {
  return await new Promise((done, fail) => {
    let output = '';
    const child = spawn(file, args, {cwd: root, env, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'});
    if (capture) child.stdout.on('data', data => {output += data.toString();});
    child.once('error', fail);
    child.once('close', code => code === 0 ? done(output) : fail(new Error('Native verification failed: ' + code + '\n' + output)));
  });
}
const report = join(root, '.local/native-tests.txt');
await run(join(root, 'apps/agent-qt/build', process.platform === 'win32' ? 'Release/CodexerNativeTests.exe' : 'CodexerNativeTests'), ['-o', report + ',txt']);
console.log('Native backend regression passed. Report: ' + report);
await run(join(root, 'apps/agent-qt/build', process.platform === 'win32' ? 'Release/CodexerUiTests.exe' : 'CodexerUiTests'), ['-o', join(root,'.local/native-ui-tests.txt') + ',txt']);
console.log('Native UI interaction regression passed. Report: .local/native-ui-tests.txt');
await run(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/check-native-protocol.ts')]);
