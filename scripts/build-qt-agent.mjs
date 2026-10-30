import {spawn, execFileSync} from 'node:child_process';
import {mkdir, readFile, cp, access, writeFile, readdir} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), app = join(root, 'apps/agent-qt');
const {version} = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
const flags = new Set(process.argv.slice(2));
const qt = process.env.CODEXER_QT_ROOT || join(root, '.local/qt/6.8.3', process.platform === 'win32' ? 'msvc2022_64' : 'macos');
const output = join(app, 'build'), stage = join(app, 'stage');
async function run(file, args, cwd = root) {
  await new Promise((done, fail) => {const child = spawn(file, args, {cwd, windowsHide: true, stdio: 'inherit'}); child.once('error', fail); child.once('exit', code => code === 0 ? done() : fail(new Error(`${file} exited ${code}`)));});
}
const cmake = process.env.CODEXER_CMAKE || (process.platform === 'win32' ? 'C:/Program Files/CMake/bin/cmake.exe' : 'cmake');
await access(join(qt, 'lib/cmake/Qt6/Qt6Config.cmake'));
const configure = ['-S', app, '-B', output, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_PREFIX_PATH=' + qt];
if (process.platform === 'win32') configure.push('-A', 'x64');
await run(cmake, configure); await run(cmake, ['--build', output, '--config', 'Release', '--parallel', '4']);
await mkdir(stage, {recursive: true});
let resources = stage;
if (process.platform === 'win32') {
  await cp(join(output, 'Release/Codexer Agent.exe'), join(stage, 'Codexer Agent.exe'));
  await run(join(qt, 'bin/windeployqt.exe'), ['--release', '--no-translations', '--no-opengl-sw', '--no-system-d3d-compiler', join(stage, 'Codexer Agent.exe')]);
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const visualStudio = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], {encoding: 'utf8', windowsHide: true}).trim();
  const redist = join(visualStudio, 'VC/Redist/MSVC');
  const versions = (await readdir(redist)).filter(name => /^\d/.test(name)).sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
  const architecture = join(redist, versions[0], 'x64');
  const crt = join(architecture, (await readdir(architecture)).find(name => /^Microsoft\.VC\d+\.CRT$/.test(name)));
  for (const name of await readdir(crt)) if (name.endsWith('.dll')) await cp(join(crt, name), join(stage, name));
} else {
  await cp(join(output, 'Codexer Agent.app'), join(stage, 'Codexer Agent.app'), {recursive: true});
  await run(join(qt, 'bin/macdeployqt'), [join(stage, 'Codexer Agent.app')]);
  resources = join(stage, 'Codexer Agent.app/Contents/MacOS');
}
await mkdir(join(resources, 'runtime'), {recursive: true}); await mkdir(join(resources, 'service'), {recursive: true});
await cp(process.execPath, join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
await build({entryPoints: [join(app, 'src/service.ts')], outfile: join(resources, 'service/agent.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'info', define: {'process.env.CODEXER_AGENT_BUILD_VERSION': JSON.stringify(version)}});
await cp(join(root, 'apps/desktop/assets/icon.ico'), join(resources, 'icon.ico'));
if (process.platform === 'win32') {
  await run(join(root, 'node_modules/electron-winstaller/vendor/rcedit.exe'), [join(stage, 'Codexer Agent.exe'), '--set-icon', join(resources, 'icon.ico'), '--set-file-version', version, '--set-product-version', version, '--set-version-string', 'ProductName', 'Codexer Agent', '--set-version-string', 'FileDescription', 'Codexer Agent · Qt Widgets']);
}
const licenses = join(resources, 'licenses'); await mkdir(licenses, {recursive: true});
const cachedLicenses = join(root, '.local/qt-licenses'); await mkdir(cachedLicenses, {recursive: true});
for (const name of ['LGPL-3.0-only.txt', 'GPL-3.0-only.txt', 'Qt-GPL-exception-1.0.txt']) {
  const cache = join(cachedLicenses, name);
  try {await access(cache);} catch {
    const response = await fetch(`https://api.github.com/repos/qt/qtbase/contents/LICENSES/${name}?ref=v6.8.3`, {headers: {'User-Agent': 'Codexer-build'}, signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('Cannot retrieve Qt license ' + name);
    await writeFile(cache, Buffer.from((await response.json()).content, 'base64'));
  }
  await cp(cache, join(licenses, name));
}
await writeFile(join(licenses, 'Qt-NOTICE.txt'), 'This application dynamically links Qt 6.8.3 (QtCore, QtGui, QtWidgets, QtNetwork) under LGPL-3.0. Qt libraries may be replaced with compatible modified builds. Corresponding source: https://github.com/qt/qtbase/tree/v6.8.3\nBuild and relink instructions: https://github.com/bunnya33/codexer/tree/main/apps/agent-qt\n');
const nodeLicense = join(root, 'apps/control-native/Node-LICENSE.txt');
if (process.version === 'v24.11.1') await cp(nodeLicense, join(licenses, 'Node-LICENSE.txt'));
else {const response = await fetch(`https://api.github.com/repos/nodejs/node/contents/LICENSE?ref=${process.version}`, {headers: {'User-Agent': 'Codexer-build'}, signal: AbortSignal.timeout(30000)}); if (!response.ok) throw new Error('Cannot retrieve Node license'); await writeFile(join(licenses, 'Node-LICENSE.txt'), Buffer.from((await response.json()).content, 'base64'));}
for (const name of ['zod', 'ws', 'immer', 'markdown-it', 'markdown-it-task-lists', 'highlight.js']) {
  const source = join(root, 'node_modules', name);
  for (const file of await readdir(source)) if (/^licen[cs]e/i.test(file)) await cp(join(source, file), join(licenses, name + '-' + file));
}
await writeFile(join(resources, 'qt-build.json'), JSON.stringify({name: 'Codexer Agent', version, ui: 'Qt Widgets', qt: '6.8.3', node: process.version, architecture: process.arch, electron: false, credentialCompatibility: 'DPAPI / Keychain; Electron encrypted login migration'}, null, 2));
if (flags.has('--stage-only')) {console.log(stage); process.exit(0);}
const {build: packageBuild, Platform, Arch} = await import('electron-builder');
const release = join(app, 'release'); await mkdir(release, {recursive: true});
if (process.platform !== 'win32') throw new Error('macOS packaging requires separate native validation; staged app retained.');
await mkdir(join(stage, 'resources'), {recursive: true});
const artifacts = await packageBuild({projectDir: join(root, 'apps/desktop'), prepackaged: stage, targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64), publish: 'never', config: {
  appId: 'com.codexer.connector', productName: 'Codexer Agent', executableName: 'Codexer Agent', electronVersion: '44.5.1', npmRebuild: false,
  directories: {output: release}, win: {icon: join(resources, 'icon.ico'), signAndEditExecutable: false, signExecutable: false},
  nsis: {oneClick: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, artifactName: `Codexer-Agent-Qt-Setup-${version}-x64.exe`},
  portable: {artifactName: `Codexer-Agent-Qt-Portable-${version}-x64.exe`},
}});
for (const path of artifacts) {const hash = createHash('sha256').update(await readFile(path)).digest('hex'); await writeFile(path + '.sha256', hash + '  ' + path.split(/[\\/]/).at(-1) + '\n');}
console.log(JSON.stringify({version, artifacts}, null, 2));
