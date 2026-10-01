import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray, utilityProcess, type UtilityProcess } from 'electron';
import { readFile, writeFile, mkdir, rename, rm, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectorController, defaultSettings, type Vault, type Worker } from './controller.js';
import { validateRelayUrl, type AgentCredentials } from '../../pc-agent/src/auth.js';
import type { Settings } from './types.js';

let window: BrowserWindow | null = null, tray: Tray | null = null, controller: ConnectorController;
let quitting = false, quitInProgress = false;
const root = __dirname;
// Isolated acceptance profiles keep tests away from the user's settings and login items.
if (process.env.CODEXER_USER_DATA_DIR) app.setPath('userData', process.env.CODEXER_USER_DATA_DIR);
async function atomicWrite(path: string, data: string | Buffer) { await writeFile(path + '.tmp', data, { mode: 0o600 }); await rename(path + '.tmp', path); }
function showWindow() { window?.show(); window?.focus(); }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    const directory = app.getPath('userData'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const credentialFile = join(directory, 'session.enc'), settingsFile = join(directory, 'settings.json');
    const available = () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    const vault: Vault = {
      available,
      async read() { if (!available()) return null; const value = await readFile(credentialFile).catch(() => null); return value ? JSON.parse(safeStorage.decryptString(value)) as AgentCredentials : null; },
      async write(credentials) { if (!available()) throw new Error('secure-storage-unavailable'); await atomicWrite(credentialFile, safeStorage.encryptString(JSON.stringify(credentials))); },
      async clear() { await rm(credentialFile, { force: true }); },
    };
    let child: UtilityProcess | null = null, requestId = 0;
    const waiters = new Map<number, { resolve: () => void; reject: () => void; timer: NodeJS.Timeout }>();
    const request = (action: string, extra: object = {}) => new Promise<void>((resolve, reject) => {
      if (!child) { reject(new Error('worker-unavailable')); return; }
      const id = ++requestId, timer = setTimeout(() => { waiters.delete(id); reject(new Error('worker-timeout')); }, 30000);
      waiters.set(id, { resolve, reject: () => reject(new Error('worker-failed')), timer }); child.postMessage({ id, action, ...extra });
    });
    const worker: Worker = {
      async start(credentials, settings) {
        if (!child) {
          child = utilityProcess.fork(join(root, 'worker.cjs'), [], { serviceName: 'Codexer Agent', stdio: 'pipe' });
          const launched = child;
          // Adapter output may contain project text or addresses. The UI receives diagnostic codes only.
          child.stdout?.resume(); child.stderr?.resume();
          child.on('message', message => {
            if (child !== launched) return;
            if (message.type === 'reply') { const waiter = waiters.get(message.id); if (waiter) { clearTimeout(waiter.timer); waiters.delete(message.id); message.ok ? waiter.resolve() : waiter.reject(); } }
            else if (message.type === 'status') controller.update(message.status);
            else if (message.type === 'diagnostic') controller.log(message.code);
          });
          child.on('exit', () => { if (child !== launched) return; child = null; for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(); } waiters.clear(); controller.workerExited(); });
        }
        await request('start', { credentials, settings, directory: join(directory, 'agent') });
      },
      async disconnect() { if (child) await request('disconnect'); },
      async reconnect() { await request('reconnect'); },
      async stop() { if (child) { const old = child; try { await request('stop'); } finally { if (child === old) child = null; old.kill(); } } },
    };
    let settings = defaultSettings();
    const saved = await readFile(settingsFile, 'utf8').catch(() => null);
    if (saved) { try { settings = { ...settings, ...JSON.parse(saved) }; } catch { /* Recover with defaults. */ } }
    const persist = async (next: Settings) => { if (!process.env.CODEXER_USER_DATA_DIR) app.setLoginItemSettings({ openAtLogin: next.openAtLogin, ...(process.platform === 'win32' ? { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: [] } : {}) }); await atomicWrite(settingsFile, JSON.stringify(next, null, 2)); };
    try { controller = new ConnectorController(vault, worker, settings, persist, app.getVersion()); }
    catch { controller = new ConnectorController(vault, worker, defaultSettings(), persist, app.getVersion()); controller.log('settings-recovery-required'); }
    const icon = nativeImage.createFromPath(join(root, 'icon.png'));
    window = new BrowserWindow({ width: 1180, height: 800, minWidth: 940, minHeight: 680, title: 'Codexer · 桌面连接器', frame: false, icon, backgroundColor: '#f5f7fb', show: false, webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    const windowState = () => ({ maximized: !!window && (window.isMaximized() || window.isFullScreen()), focused: window?.isFocused() ?? false });
    const publishWindowState = () => window?.webContents.send('codexer:window:state', windowState());
    window.on('maximize', publishWindowState); window.on('unmaximize', publishWindowState);
    window.on('enter-full-screen', publishWindowState); window.on('leave-full-screen', publishWindowState);
    window.on('focus', publishWindowState); window.on('blur', publishWindowState);
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ label: 'Codexer', submenu: [{ role: 'about' }, { type: 'separator' }, { label: '显示控制台', click: showWindow }, { role: 'hide' }, { label: '退出', click: () => app.quit() }] }, { role: 'editMenu' }]) : null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('close', event => { if (quitting) return; event.preventDefault(); if (controller.state().settings.minimizeToTray) window?.hide(); else app.quit(); });
    window.on('closed', () => { window = null; });
    tray = new Tray(process.platform === 'darwin' ? icon.resize({ width: 18, height: 18 }) : icon.resize({ width: 32, height: 32 }));
    tray.on('double-click', showWindow); tray.on('click', showWindow);
    const guarded = (action: () => Promise<void>) => { void action().catch(() => undefined); };
    let lastLogAt = 0;
    controller.on('state', state => {
      window?.webContents.send('codexer:state', state);
      const label = state.phase === 'connected' ? '已连接' : state.phase === 'signed-out' ? '未登录' : state.phase === 'disconnected' ? '已断开' : '连接中';
      tray?.setToolTip(`Codexer · ${label}`);
      tray?.setContextMenu(Menu.buildFromTemplate([{ label: `Codexer · ${label}`, enabled: false }, { label: '显示控制台', click: showWindow }, { type: 'separator' }, { label: '连接', enabled: state.loggedIn && !state.busy && state.phase === 'disconnected', click: () => guarded(() => controller.connect()) }, { label: '断开远程连接', enabled: state.phase !== 'disconnected' && state.phase !== 'signed-out', click: () => guarded(() => controller.disconnect()) }, { label: '重连', enabled: state.loggedIn && !state.busy, click: () => guarded(() => controller.reconnect()) }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
      const log = state.logs.at(-1);
      if (log && log.at > lastLogAt) {
        lastLogAt = log.at;
        void (async () => { const file = join(directory, 'diagnostics.log'); if ((await stat(file).catch(() => null))?.size! > 1024 * 1024) await rename(file, file + '.previous').catch(() => undefined); await appendFile(file, JSON.stringify(log) + '\n', { mode: 0o600 }); })().catch(() => undefined);
      }
    });
    function handle(name: string, callback: (...args: any[]) => unknown) { ipcMain.handle('codexer:' + name, (event, ...args) => { if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('untrusted-sender'); return callback(...args); }); }
    handle('state', () => controller.state());
    handle('window:state', windowState);
    handle('window:minimize', () => window?.minimize());
    handle('window:toggleMaximize', () => { if (window?.isFullScreen()) window.setFullScreen(false); else if (window?.isMaximized()) window.unmaximize(); else window?.maximize(); });
    // Use the existing close/tray/quit flow, including active-task confirmation.
    handle('window:close', () => window?.close());
    handle('login', (username: unknown, password: unknown) => { if (typeof username !== 'string' || typeof password !== 'string') throw new Error('invalid-login'); return controller.login(username, password); });
    handle('logout', () => controller.logout()); handle('connect', () => controller.connect()); handle('disconnect', () => controller.disconnect()); handle('reconnect', () => controller.reconnect()); handle('save', (value: Settings) => controller.save(value));
    handle('pick', async (kind: string) => { if (kind !== 'home' && kind !== 'binary') throw new Error('invalid-dialog'); const result = await dialog.showOpenDialog(window!, { title: kind === 'home' ? '选择 Codex 数据目录' : '选择 Codex 可执行文件', properties: [kind === 'home' ? 'openDirectory' : 'openFile'] }); return result.canceled ? null : result.filePaths[0] ?? null; });
    handle('exportLogs', async () => { const result = await dialog.showSaveDialog(window!, { title: '导出脱敏诊断', defaultPath: 'codexer-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] }); if (result.canceled || !result.filePath) return null; const state = controller.state(); await writeFile(result.filePath, JSON.stringify({ version: state.version, platform: process.platform, phase: state.phase, status: state.status, logs: state.logs }, null, 2)); return result.filePath; });
    handle('openControl', () => { const settings = controller.state().settings, url = validateRelayUrl(settings.relayUrl, settings.allowHttp); return shell.openExternal(url.origin); });
    await window.loadFile(join(root, 'renderer', 'index.html')); window.show();
    await controller.initialize(); controller.log('console-ready');
    // Persist the installation ID even before the first login.
    await persist(controller.state().settings);
  }).catch(() => { void dialog.showErrorBox('Codexer 启动失败', '无法初始化本地配置或运行依赖，请检查数据目录权限后重试。'); app.exit(1); });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
  app.on('before-quit', event => {
    if (quitting || !controller) return;
    event.preventDefault(); if (quitInProgress) return; quitInProgress = true;
    void (async () => {
      if (controller.state().status?.activeTasks) { const result = await dialog.showMessageBox({ type: 'warning', title: '退出 Codexer', message: '本机仍有任务运行', detail: '退出会停止由连接器启动的本机运行服务。仅想停止远程控制时，请使用“断开”。', buttons: ['留在后台', '退出'], defaultId: 0, cancelId: 0 }); if (result.response === 0) { quitInProgress = false; return; } }
      await controller.shutdown().catch(() => undefined); quitting = true; tray?.destroy(); app.quit();
    })();
  });
}
