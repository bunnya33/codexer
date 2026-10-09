import { app, BrowserWindow, ipcMain, Menu, session, shell, WebContentsView } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  externalWebUrl,
  normalizeServerUrl,
  sameServerOrigin,
  trustedSetupRequest,
} from "./policy.js";
import { readServerUrl, saveServerUrl } from "./settings.js";
import type { ConnectionResult, SetupState } from "./types.js";
import { attachChrome, registerChromeIpc, TITLEBAR_HEIGHT } from "./chrome.js";

app.setName("RelayDesk");
app.setAppUserModelId("com.codexer.control");
app.setPath(
  "userData",
  process.env.CODEXER_CONTROL_USER_DATA_DIR || join(app.getPath("appData"), "CodexerControl"),
);

const root = __dirname;
const setupPath = join(root, "setup", "index.html");
const setupUrl = pathToFileURL(setupPath).href;
const shellPath = join(root, "shell", "index.html");
const shellUrl = pathToFileURL(shellPath).href;
const icon = join(root, "icon.png");
let setupWindow: BrowserWindow | null = null;
let controlWindow: BrowserWindow | null = null;
let controlView: WebContentsView | null = null;
let shellReady: Promise<void> | null = null;
let serverUrl: string | null = null;
let pendingUrl: string | null = null;
let message = "";
let connecting = false;
let attempt = 0;
let quitting = false;

function visibleControl(): boolean {
  return !!controlWindow && !controlWindow.isDestroyed() && controlWindow.isVisible();
}

function showWindow(): void {
  const window = setupWindow ?? controlWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function setupState(): SetupState {
  return { url: pendingUrl ?? serverUrl ?? "", version: app.getVersion(), error: message };
}

function assertSetupSender(event: IpcMainInvokeEvent): void {
  if (
    !setupWindow ||
    !trustedSetupRequest(event, {
      sender: setupWindow.webContents,
      frame: setupWindow.webContents.mainFrame,
      url: setupUrl,
    })
  )
    throw new Error("untrusted-sender");
}

function showSetup(error = ""): void {
  if (quitting) return;
  message = error;
  if (setupWindow && !setupWindow.isDestroyed()) {
    showWindow();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 640,
    height: 550,
    minWidth: 520,
    minHeight: 520,
    title: "RelayDesk · 连接服务器",
    frame: false,
    icon,
    backgroundColor: "#f6f8f8",
    show: false,
    ...(controlWindow ? { parent: controlWindow, modal: true } : {}),
    webPreferences: {
      preload: join(root, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const window = setupWindow;
  window.setMenu(null);
  attachChrome(window, setupUrl, () => showMenu(window));
  bindShortcuts(window.webContents, window);
  window.once("ready-to-show", () => {
    if (!quitting) window.show();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    if (setupWindow === window) setupWindow = null;
    if (!visibleControl()) app.quit();
  });
  void window.loadFile(setupPath).catch(() => app.quit());
}

function openExternal(value: string): void {
  const url = externalWebUrl(value);
  if (url) void shell.openExternal(url).catch(() => undefined);
}

/** 本地壳只负责标题栏；服务器页面在无 preload 的独立视图中运行。 */
function createControlWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: "RelayDesk · 会话控制端",
    frame: false,
    icon,
    backgroundColor: "#f6f8f8",
    show: false,
    webPreferences: {
      preload: join(root, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  controlWindow = window;
  window.setMenu(null);
  attachChrome(window, shellUrl, () => showMenu(window));
  bindShortcuts(window.webContents, window);
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const view = new WebContentsView({
    webPreferences: {
      partition: "persist:control",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  controlView = view;
  window.contentView.addChildView(view);
  const resize = () => {
    const [width = 0, height = 0] = window.getContentSize();
    view.setBounds({
      x: 0,
      y: TITLEBAR_HEIGHT,
      width,
      height: Math.max(0, height - TITLEBAR_HEIGHT),
    });
  };
  window.on("resize", resize);
  resize();
  bindShortcuts(view.webContents, window);
  shellReady = window.loadFile(shellPath);
  const origin = () => pendingUrl ?? serverUrl;
  view.webContents.on("will-navigate", (event, url) => {
    if (!sameServerOrigin(url, origin())) {
      event.preventDefault();
      openExternal(url);
    }
  });
  view.webContents.on("will-redirect", (event, url) => {
    if (!sameServerOrigin(url, origin())) event.preventDefault();
  });
  view.webContents.setWindowOpenHandler((details) => {
    if (sameServerOrigin(view.webContents.getURL(), origin())) openExternal(details.url);
    return { action: "deny" };
  });
  view.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (!connecting && mainFrame && code !== -3 && !quitting) {
      window.hide();
      showSetup("无法加载控制页面，请检查服务器地址或网络后重试。");
    }
  });
  window.on("closed", () => {
    if (controlWindow === window) controlWindow = null;
    if (controlView === view) {
      controlView = null;
      shellReady = null;
    }
    // WebContentsView 的内容不会随父窗口自动销毁，需要显式关闭远程通道。
    if (!view.webContents.isDestroyed()) view.webContents.close();
    attempt++;
  });
  return window;
}

async function connect(value: unknown): Promise<ConnectionResult> {
  if (connecting) return { ok: false, error: "正在连接服务器，请稍候。" };
  let url: string;
  try {
    url = normalizeServerUrl(value);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const current = ++attempt;
  connecting = true;
  pendingUrl = url;
  const window = controlWindow ?? createControlWindow();
  const contents = controlView!.webContents;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loaded = false;
  try {
    await Promise.race([
      Promise.all([shellReady, contents.loadURL(url)]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("control-load-timeout")), 30000);
      }),
    ]);
    if (quitting || current !== attempt) return { ok: false };
    loaded = true;
    await saveServerUrl(app.getPath("userData"), url);
    if (quitting || current !== attempt) return { ok: false };
    serverUrl = url;
    message = "";
    window.show();
    window.focus();
    setupWindow?.close();
    contents.focus();
    return { ok: true };
  } catch {
    if (quitting || current !== attempt) return { ok: false };
    contents.stop();
    window.hide();
    message = loaded
      ? "无法保存服务器设置，请检查本地数据目录权限。"
      : "无法连接服务器，请检查地址或网络后重试。";
    showSetup(message);
    return { ok: false, error: message };
  } finally {
    if (timer) clearTimeout(timer);
    if (current === attempt) {
      connecting = false;
      pendingUrl = null;
    }
  }
}

function configureSession(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  const remote = session.fromPartition("persist:control");
  const trusted = (contents: Electron.WebContents | null, origin?: string) =>
    !!controlView &&
    contents === controlView.webContents &&
    sameServerOrigin(origin ?? contents.getURL(), pendingUrl ?? serverUrl);
  remote.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === "clipboard-sanitized-write" && trusted(contents));
  });
  remote.setPermissionCheckHandler(
    (contents, permission, origin) =>
      permission === "clipboard-sanitized-write" && trusted(contents, origin),
  );
  remote.on("will-download", (event, item, contents) => {
    if (!trusted(contents)) {
      event.preventDefault();
      return;
    }
    // 图片与文件仍由控制页面触发；保存位置交给用户选择，不自动覆盖文件。
    item.setSaveDialogOptions({ title: "保存文件", defaultPath: item.getFilename() });
  });
}

function zoom(direction: number): void {
  const contents = controlView?.webContents;
  if (contents)
    contents.setZoomFactor(
      direction === 0 ? 1 : Math.max(0.5, Math.min(2, contents.getZoomFactor() + direction * 0.1)),
    );
}

function showMenu(window: BrowserWindow): void {
  Menu.buildFromTemplate([
    {
      label: "服务器地址…",
      accelerator: "Ctrl+L",
      registerAccelerator: false,
      click: () => showSetup(),
    },
    {
      label: "刷新会话页面",
      accelerator: "Ctrl+R",
      registerAccelerator: false,
      enabled: !!controlView,
      click: () => controlView?.webContents.reload(),
    },
    {
      label: "重新加载页面",
      accelerator: "Ctrl+Shift+R",
      registerAccelerator: false,
      enabled: !!controlView,
      click: () => controlView?.webContents.reloadIgnoringCache(),
    },
    {
      label: "在浏览器中打开",
      enabled: !!serverUrl,
      click: () => {
        if (serverUrl) openExternal(serverUrl);
      },
    },
    { type: "separator" },
    {
      label: "显示",
      enabled: !!controlView,
      submenu: [
        { label: "实际大小", click: () => zoom(0) },
        { label: "放大", click: () => zoom(1) },
        { label: "缩小", click: () => zoom(-1) },
        {
          label: "全屏",
          accelerator: "F11",
          registerAccelerator: false,
          click: () => window.setFullScreen(!window.isFullScreen()),
        },
      ],
    },
    { type: "separator" },
    { label: "退出 RelayDesk", click: () => app.quit() },
  ]).popup({ window, x: Math.max(0, window.getContentSize()[0]! - 184), y: TITLEBAR_HEIGHT });
}

/** 远程视图拿到键盘焦点时，标题栏快捷键仍由主进程处理。 */
function bindShortcuts(contents: Electron.WebContents, window: BrowserWindow): void {
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt) return;
    const key = input.key.toLowerCase();
    let action: (() => void) | undefined;
    if (key === "f11") action = () => window.setFullScreen(!window.isFullScreen());
    else if (input.control || input.meta) {
      if (key === "l") action = () => showSetup();
      else if (key === "r")
        action = () =>
          input.shift
            ? controlView?.webContents.reloadIgnoringCache()
            : controlView?.webContents.reload();
      else if (["+", "="].includes(key)) action = () => zoom(1);
      else if (key === "-") action = () => zoom(-1);
      else if (key === "0") action = () => zoom(0);
    }
    if (action) {
      event.preventDefault();
      action();
    }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    attempt++;
  });
  void app
    .whenReady()
    .then(async () => {
      configureSession();
      Menu.setApplicationMenu(null);
      registerChromeIpc();
      ipcMain.handle("control-setup:state", (event) => {
        assertSetupSender(event);
        return setupState();
      });
      ipcMain.handle("control-setup:connect", (event, url: unknown) => {
        assertSetupSender(event);
        return connect(url);
      });
      serverUrl = await readServerUrl(app.getPath("userData"));
      if (serverUrl) await connect(serverUrl);
      else showSetup();
    })
    .catch(() => {
      showSetup("无法初始化控制端，请检查本地数据目录权限后重试。");
    });
}
