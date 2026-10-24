import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  externalWebUrl,
  normalizeServerUrl,
  sameServerOrigin,
  trustedSetupRequest,
} from "../apps/control-desktop/src/policy";
import {
  readCloseExits,
  readServerUrl,
  saveCloseExits,
  saveServerUrl,
} from "../apps/control-desktop/src/settings";

const electron = vi.hoisted(() => {
  type Handler = (...args: any[]) => any;
  const handlers = () => {
    const events = new Map<string, Handler[]>();
    return {
      on(name: string, fn: Handler) {
        events.set(name, [...(events.get(name) ?? []), fn]);
      },
      once(name: string, fn: Handler) {
        this.on(name, fn);
      },
      emit(name: string, ...args: any[]) {
        for (const fn of events.get(name) ?? []) fn(...args);
      },
      clear() {
        events.clear();
      },
    };
  };
  const windows: MockWindow[] = [];
  const views: MockView[] = [];
  const loadUrl = vi.fn(async (_url: string): Promise<void> => undefined);
  const external = vi.fn(async (_url: string) => undefined);
  const ipc = new Map<string, Handler>();
  const messageBox = vi.fn(async (..._args: any[]) => ({ response: 0 }));
  const buildMenu = vi.fn((template: any[]) => ({ template, popup: vi.fn() }));
  const trays: MockTray[] = [];
  const paths = new Map<string, string>();
  const appEvents = handlers();
  const remoteEvents = handlers();
  let ready: () => void;
  let readyPromise: Promise<void>;
  let fileUrl = (path: string) => path;
  const remote: Record<string, any> = {
    ...remoteEvents,
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };

  class MockTray {
    events = handlers();
    menu: ReturnType<typeof buildMenu> | undefined;
    constructor(readonly icon: string) {
      trays.push(this);
    }
    on(name: string, fn: Handler) {
      this.events.on(name, fn);
    }
    setToolTip = vi.fn();
    destroy = vi.fn();
    setContextMenu(menu: ReturnType<typeof buildMenu>) {
      this.menu = menu;
    }
  }

  class MockWindow {
    events = handlers();
    visible = false;
    destroyed = false;
    contentsDestroyed = false;
    maximized = false;
    fullScreen = false;
    size = [1280, 860];
    contentView = { addChildView: vi.fn() };
    url = "";
    popup: Handler | undefined;
    frame = { url: "" };
    webEvents = handlers();
    protected contents = {
      ...this.webEvents,
      mainFrame: this.frame,
      getURL: () => this.url,
      setWindowOpenHandler: (handler: Handler) => {
        this.popup = handler;
      },
      stop: vi.fn(),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      send: vi.fn(),
      loadURL: (url: string) => this.loadURL(url),
      isDestroyed: () => this.destroyed || this.contentsDestroyed,
      close: vi.fn(() => {
        this.destroyed = true;
      }),
      focus: vi.fn(),
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
    };
    get webContents() {
      if (this.destroyed) throw new TypeError("Object has been destroyed");
      return this.contents;
    }
    constructor(
      readonly options: Record<string, any>,
      register = true,
    ) {
      if (register) windows.push(this);
    }
    setMenu = vi.fn();
    getContentSize() {
      return this.size;
    }
    isMaximized() {
      return this.maximized;
    }
    isFullScreen() {
      return this.fullScreen;
    }
    isFocused() {
      return true;
    }
    minimize = vi.fn();
    maximize() {
      this.maximized = true;
      this.events.emit("maximize");
    }
    unmaximize() {
      this.maximized = false;
      this.events.emit("unmaximize");
    }
    setFullScreen(value: boolean) {
      this.fullScreen = value;
    }
    on(name: string, fn: Handler) {
      this.events.on(name, fn);
    }
    once(name: string, fn: Handler) {
      this.events.once(name, fn);
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {}
    restore() {}
    isMinimized() {
      return false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    async loadFile(path: string) {
      this.url = this.frame.url = fileUrl(path);
      this.events.emit("ready-to-show");
      this.webEvents.emit("did-finish-load");
    }
    async loadURL(url: string) {
      this.url = this.frame.url = url;
      await loadUrl(url);
    }
    close() {
      const event = { preventDefault: vi.fn() };
      this.events.emit("close", event);
      if (event.preventDefault.mock.calls.length) return;
      this.destroy();
    }
    destroy() {
      this.destroyed = true;
      this.hide();
      this.events.emit("closed");
    }
  }

  class MockView extends MockWindow {
    bounds: Record<string, number> = {};
    constructor(options: Record<string, any>) {
      super(options, false);
      views.push(this);
    }
    setBounds(value: Record<string, number>) {
      this.bounds = value;
    }
    override get webContents() {
      return this.contents;
    }
  }

  const app = {
    ...appEvents,
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    setPath: (name: string, value: string) => {
      paths.set(name, value);
    },
    getPath: (name: string) => paths.get(name) ?? "/unused-app-data",
    getVersion: () => "0.1.2",
    requestSingleInstanceLock: () => true,
    quit: vi.fn(() => {
      appEvents.emit("before-quit");
      for (const window of windows) if (!window.isDestroyed()) window.close();
    }),
    whenReady: () => readyPromise,
  };
  return {
    windows,
    views,
    loadUrl,
    external,
    ipc,
    app,
    remote,
    MockWindow,
    MockView,
    MockTray,
    trays,
    messageBox,
    buildMenu,
    reset(url: (path: string) => string) {
      windows.length = 0;
      trays.length = 0;
      messageBox.mockReset().mockResolvedValue({ response: 0 });
      buildMenu.mockClear();
      views.length = 0;
      ipc.clear();
      paths.clear();
      fileUrl = url;
      appEvents.clear();
      remoteEvents.clear();
      loadUrl.mockReset().mockResolvedValue(undefined);
      external.mockClear();
      app.quit.mockClear();
      readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
    },
    ready: () => ready(),
  };
});

vi.mock("electron", () => ({
  app: electron.app,
  BrowserWindow: electron.MockWindow,
  WebContentsView: electron.MockView,
  Tray: electron.MockTray,
  dialog: { showMessageBox: electron.messageBox },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => {
      electron.ipc.set(name, handler);
    },
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: electron.buildMenu },
  session: {
    defaultSession: { setPermissionRequestHandler: vi.fn() },
    fromPartition: () => electron.remote,
  },
  shell: { openExternal: electron.external },
}));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codexer-control-"));
  electron.reset((path) => pathToFileURL(path).href);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  await rm(directory, { recursive: true, force: true });
});

describe("Windows control client policy and settings", () => {
  it("defaults to the tray and stores close preferences independently of the server address", async () => {
    expect(await readCloseExits(directory)).toBe(false);
    await saveServerUrl(directory, "https://relay.example.com");
    await saveCloseExits(directory, true);
    expect(await readCloseExits(directory)).toBe(true);
    expect(await readServerUrl(directory)).toBe("https://relay.example.com");
    await saveServerUrl(directory, "https://second.example.com");
    expect(await readCloseExits(directory)).toBe(true);
    await saveCloseExits(directory, false);
    expect(await readCloseExits(directory)).toBe(false);
    for (const text of ['{"closeExits":"true"}', "null", "{broken"]) {
      await writeFile(join(directory, "preferences.json"), text);
      expect(await readCloseExits(directory)).toBe(false);
    }
  });
  it("uses a server root without embedded credentials and keeps navigation on the chosen origin", () => {
    expect(normalizeServerUrl(" https://relay.example.com:443/ ")).toBe(
      "https://relay.example.com",
    );
    expect(normalizeServerUrl("http://127.0.0.1:8899")).toBe("http://127.0.0.1:8899");
    for (const value of [
      "",
      "file:///C:/a",
      "javascript:alert(1)",
      "https://u:p@relay.example.com/",
      "https://relay.example.com/admin/",
      "https://relay.example.com/?token=x",
      "https://relay.example.com/#login",
      "https://relay.example.com\n",
      null,
    ])
      expect(() => normalizeServerUrl(value)).toThrow();
    expect(
      sameServerOrigin("https://relay.example.com/v1/ws/client", "https://relay.example.com"),
    ).toBe(true);
    expect(
      sameServerOrigin("https://relay.example.com.attacker.test/", "https://relay.example.com"),
    ).toBe(false);
    expect(sameServerOrigin("http://relay.example.com/", "https://relay.example.com")).toBe(false);
    expect(externalWebUrl("file:///C:/setup.exe")).toBeNull();
    expect(externalWebUrl("ms-settings:")).toBeNull();
    expect(externalWebUrl("https://u:p@example.com/")).toBeNull();
  });

  it("allows configuration only from the exact local setup main frame", () => {
    const sender = {},
      frame = { url: "file:///C:/app/setup/index.html" };
    const expected = { sender, frame, url: frame.url };
    expect(trustedSetupRequest({ sender, senderFrame: frame }, expected)).toBe(true);
    expect(trustedSetupRequest({ sender: {}, senderFrame: frame }, expected)).toBe(false);
    expect(trustedSetupRequest({ sender, senderFrame: { url: frame.url } }, expected)).toBe(false);
    expect(trustedSetupRequest({ sender, senderFrame: null }, expected)).toBe(false);
    frame.url = "https://relay.example.com/";
    expect(trustedSetupRequest({ sender, senderFrame: frame }, expected)).toBe(false);
  });

  it("persists only a normalized server address and recovers from an invalid file", async () => {
    expect(await readServerUrl(directory)).toBeNull();
    await saveServerUrl(directory, "https://relay.example.com/");
    expect(JSON.parse(await readFile(join(directory, "server.json"), "utf8"))).toEqual({
      url: "https://relay.example.com",
    });
    expect(await readServerUrl(directory)).toBe("https://relay.example.com");
    await expect(saveServerUrl(directory, "https://user:secret@example.com/")).rejects.toThrow();
    expect(await readServerUrl(directory)).toBe("https://relay.example.com");
    await writeFile(
      join(directory, "server.json"),
      JSON.stringify({ url: "file:///C:/setup.exe" }),
    );
    expect(await readServerUrl(directory)).toBeNull();
  });
});

async function start() {
  vi.resetModules();
  vi.stubEnv("CODEXER_CONTROL_USER_DATA_DIR", directory);
  vi.stubGlobal("__dirname", join(directory, "dist"));
  await mkdir(join(directory, "dist"), { recursive: true });
  await import("../apps/control-desktop/src/main");
  electron.ready();
  await vi.waitFor(() => expect(electron.windows.length).toBeGreaterThan(0));
}

function setupEvent() {
  const setup = electron.windows.find((window) => window.options.webPreferences.preload)!;
  return { sender: setup.webContents, senderFrame: setup.frame };
}

describe("Windows control main process through mocked Electron windows", () => {
  it("hides to the tray by default and restores the same window from the tray or a second launch", async () => {
    await start();
    const setup = electron.windows[0]!,
      tray = electron.trays[0]!;
    const event = setupEvent();
    electron.ipc.get("relaydesk:window:close")!(event);
    expect(setup.visible).toBe(false);
    expect(setup.isDestroyed()).toBe(false);
    expect(electron.app.quit).not.toHaveBeenCalled();
    expect(electron.messageBox).not.toHaveBeenCalled();
    tray.events.emit("click");
    expect(setup.visible).toBe(true);
    setup.close();
    tray.menu!.template.find((item) => item.label === "打开 Codexer Control").click();
    expect(setup.visible).toBe(true);
    setup.close();
    electron.app.emit("second-instance");
    expect(setup.visible).toBe(true);
    expect(electron.windows).toHaveLength(1);
  });

  it("saves the setting from either menu and asks before exiting, with cancel as the default", async () => {
    await start();
    const setup = electron.windows[0]!,
      event = setupEvent();
    electron.ipc.get("relaydesk:window:menu")!(event);
    const menu = electron.buildMenu.mock.results.at(-1)!.value as ReturnType<
      typeof electron.buildMenu
    >;
    const setting = menu.template.find((item) => item.label === "设置").submenu[0];
    expect(setting.checked).toBe(false);
    await setting.click({ checked: true });
    expect(await readCloseExits(directory)).toBe(true);
    await vi.waitFor(() =>
      expect(
        electron.trays[0]!.menu!.template.find((item) => item.label === "设置").submenu[0].checked,
      ).toBe(true),
    );
    electron.ipc.get("relaydesk:window:close")!(event);
    await vi.waitFor(() => expect(electron.messageBox).toHaveBeenCalledOnce());
    expect(electron.messageBox.mock.calls[0]![1]).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      buttons: ["取消", "退出进程"],
    });
    expect(setup.visible).toBe(true);
    expect(setup.isDestroyed()).toBe(false);
    expect(electron.app.quit).not.toHaveBeenCalled();
    const traySetting = electron.trays[0]!.menu!.template.find((item) => item.label === "设置")
      .submenu[0];
    await traySetting.click({ checked: false });
    expect(await readCloseExits(directory)).toBe(false);
    await vi.waitFor(() =>
      expect(
        electron.trays[0]!.menu!.template.find((item) => item.label === "设置").submenu[0].checked,
      ).toBe(false),
    );
    setup.close();
    expect(setup.visible).toBe(false);
    expect(electron.messageBox).toHaveBeenCalledOnce();
  });

  it("deduplicates pending exit confirmation and quits only after confirmation", async () => {
    await saveCloseExits(directory, true);
    let respond!: (answer: { response: number }) => void;
    electron.messageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    await start();
    const setup = electron.windows[0]!;
    setup.close();
    setup.close();
    expect(electron.messageBox).toHaveBeenCalledOnce();
    expect(electron.app.quit).not.toHaveBeenCalled();
    respond({ response: 1 });
    await vi.waitFor(() => expect(setup.isDestroyed()).toBe(true));
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(electron.trays[0]!.destroy).toHaveBeenCalledOnce();
  });

  it("keeps a pending connection hidden until the user restores it from the tray", async () => {
    await start();
    let finish!: () => void;
    electron.loadUrl.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = electron.ipc.get("control-setup:connect")!(
      setupEvent(),
      "https://relay.example.com",
    );
    const setup = electron.windows[0]!,
      control = electron.windows[1]!;
    setup.close();
    finish();
    expect(await pending).toEqual({ ok: true });
    expect(setup.isDestroyed()).toBe(true);
    expect(control.visible).toBe(false);
    expect(electron.messageBox).not.toHaveBeenCalled();
    expect(electron.app.quit).not.toHaveBeenCalled();
    electron.trays[0]!.events.emit("click");
    expect(control.visible).toBe(true);
  });

  it("keeps the old close behavior if saving fails and allows system quit without confirmation", async () => {
    await start();
    await mkdir(join(directory, "preferences.json.tmp"));
    const setting = electron.trays[0]!.menu!.template.find((item) => item.label === "设置")
      .submenu[0];
    await setting.click({ checked: true });
    await vi.waitFor(() => expect(electron.messageBox).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        electron.trays[0]!.menu!.template.find((item) => item.label === "设置").submenu[0].enabled,
      ).toBe(true),
    );
    electron.windows[0]!.close();
    expect(electron.windows[0]!.visible).toBe(false);
    electron.app.quit();
    expect(electron.windows[0]!.isDestroyed()).toBe(true);
    expect(electron.messageBox).toHaveBeenCalledOnce();
  });

  it("closes the setup window without reading destroyed native properties and ignores late window events", async () => {
    await saveCloseExits(directory, true);
    electron.messageBox.mockResolvedValueOnce({ response: 1 });
    await start();
    const setup = electron.windows[0]!,
      event = setupEvent(),
      contents = setup.webContents;
    expect(() => electron.ipc.get("relaydesk:window:close")!(event)).not.toThrow();
    await vi.waitFor(() => expect(setup.isDestroyed()).toBe(true));
    expect(setup.isDestroyed()).toBe(true);
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(electron.trays[0]!.destroy).toHaveBeenCalledOnce();
    expect(() => setup.webContents).toThrow("Object has been destroyed");
    expect(() => electron.ipc.get("relaydesk:window:state")!(event)).toThrow("untrusted-sender");
    contents.send.mockClear();
    for (const name of ["focus", "blur", "maximize", "leave-full-screen"])
      expect(() => setup.events.emit(name)).not.toThrow();
    expect(() => setup.webEvents.emit("did-finish-load")).not.toThrow();
    expect(contents.send).not.toHaveBeenCalled();
  });

  it("stops publishing title bar state once the local renderer is destroyed", async () => {
    await start();
    const setup = electron.windows[0]!,
      contents = setup.webContents;
    contents.send.mockClear();
    setup.contentsDestroyed = true;
    setup.events.emit("blur");
    setup.webEvents.emit("did-finish-load");
    expect(contents.send).not.toHaveBeenCalled();
    expect(() =>
      electron.ipc.get("relaydesk:window:state")!({ sender: contents, senderFrame: setup.frame }),
    ).toThrow("untrusted-sender");
  });

  it("opens the control page in a separate sandbox with no native bridge or Agent", async () => {
    await start();
    const state = electron.ipc.get("control-setup:state")!(setupEvent());
    expect(state).toEqual({ url: "", version: "0.1.2", error: "" });
    const result = await electron.ipc.get("control-setup:connect")!(
      setupEvent(),
      "http://127.0.0.1:8899/",
    );
    expect(result).toEqual({ ok: true });
    const control = electron.windows.find(
      (window) => window.options.title === "Codexer Control · 会话控制端",
    )!;
    const view = electron.views[0]!;
    expect(view.options.webPreferences).toEqual({
      partition: "persist:control",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect(control.visible).toBe(true);
    expect(control.options.frame).toBe(false);
    expect(control.url).toContain("/shell/index.html");
    expect(control.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.bounds).toEqual({ x: 0, y: 46, width: 1280, height: 814 });
    expect(electron.app.setName).toHaveBeenLastCalledWith("RelayDesk");
    expect(await readServerUrl(directory)).toBe("http://127.0.0.1:8899");
    expect(electron.app.quit).not.toHaveBeenCalled();
    expect(() =>
      electron.ipc.get("control-setup:state")!({
        sender: view.webContents,
        senderFrame: view.frame,
      }),
    ).toThrow("untrusted-sender");
  });

  it("retains the setup form after a load failure, saves no failed address and permits retry", async () => {
    await start();
    electron.loadUrl.mockRejectedValueOnce(new Error("network unavailable"));
    const event = setupEvent();
    const result = await electron.ipc.get("control-setup:connect")!(
      event,
      "https://relay.example.com",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法连接服务器");
    expect(await readServerUrl(directory)).toBeNull();
    expect(electron.windows.find((window) => window.options.webPreferences.preload)!.visible).toBe(
      true,
    );
    expect(
      await electron.ipc.get("control-setup:connect")!(event, "https://relay.example.com"),
    ).toEqual({ ok: true });
  });

  it("restores a saved origin, blocks protocol escapes and gives downloads a user-selected save path", async () => {
    await saveServerUrl(directory, "https://relay.example.com");
    await start();
    const control = electron.windows[0]!;
    const view = electron.views[0]!;
    await vi.waitFor(() => expect(control.visible).toBe(true));
    expect(electron.loadUrl).toHaveBeenCalledWith("https://relay.example.com");
    const event = { preventDefault: vi.fn() };
    view.webEvents.emit("will-navigate", event, "file:///C:/secret.txt");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(electron.external).not.toHaveBeenCalled();
    view.popup!({ url: "https://example.com/help" });
    expect(electron.external).toHaveBeenCalledWith("https://example.com/help");
    const item = { getFilename: () => "图片.png", setSaveDialogOptions: vi.fn() };
    electron.remote.emit("will-download", event, item, view.webContents);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({
      title: "保存文件",
      defaultPath: "图片.png",
    });
    event.preventDefault.mockClear();
    item.setSaveDialogOptions.mockClear();
    electron.remote.emit("will-download", event, item, {});
    expect(event.preventDefault).toHaveBeenCalled();
    expect(item.setSaveDialogOptions).not.toHaveBeenCalled();
    const permission = electron.remote.setPermissionCheckHandler.mock.calls.at(-1)![0];
    expect(
      permission(view.webContents, "clipboard-sanitized-write", "https://relay.example.com"),
    ).toBe(true);
    expect(permission(view.webContents, "clipboard-read", "https://relay.example.com")).toBe(false);
    expect(
      permission(view.webContents, "clipboard-sanitized-write", "https://attacker.example.com"),
    ).toBe(false);
  });

  it("routes title bar controls only to their owning local window and publishes maximize state", async () => {
    await start();
    const event = setupEvent();
    const setup = electron.windows[0]!;
    electron.ipc.get("relaydesk:window:minimize")!(event);
    expect(setup.minimize).toHaveBeenCalled();
    electron.ipc.get("relaydesk:window:toggleMaximize")!(event);
    expect(setup.maximized).toBe(true);
    expect(setup.webContents.send).toHaveBeenLastCalledWith("relaydesk:window:state", {
      maximized: true,
      focused: true,
    });
    electron.ipc.get("relaydesk:window:toggleMaximize")!(event);
    expect(setup.maximized).toBe(false);
    setup.fullScreen = true;
    electron.ipc.get("relaydesk:window:toggleMaximize")!(event);
    expect(setup.fullScreen).toBe(false);
    expect(() =>
      electron.ipc.get("relaydesk:window:minimize")!({
        ...event,
        senderFrame: { url: setup.frame.url },
      }),
    ).toThrow("untrusted-sender");
    await electron.ipc.get("control-setup:connect")!(event, "https://relay.example.com");
    const view = electron.views[0]!;
    expect(() =>
      electron.ipc.get("relaydesk:window:close")!({
        sender: view.webContents,
        senderFrame: view.frame,
      }),
    ).toThrow("untrusted-sender");
    expect(() => electron.ipc.get("relaydesk:window:state")!(event)).toThrow("untrusted-sender");
  });

  it("resizes the server view below the fixed title bar, handles shortcuts with remote focus and disposes it", async () => {
    await saveServerUrl(directory, "https://relay.example.com");
    await start();
    const control = electron.windows[0]!,
      view = electron.views[0]!;
    await vi.waitFor(() => expect(control.visible).toBe(true));
    control.size = [900, 600];
    control.events.emit("resize");
    expect(view.bounds).toEqual({ x: 0, y: 46, width: 900, height: 554 });
    const event = { preventDefault: vi.fn() };
    view.webEvents.emit("before-input-event", event, {
      type: "keyDown",
      key: "r",
      control: true,
      shift: true,
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(view.webContents.reloadIgnoringCache).toHaveBeenCalled();
    view.webEvents.emit("before-input-event", event, { type: "keyDown", key: "l", control: true });
    const setup = electron.windows[1]!;
    expect(setup.options.frame).toBe(false);
    expect(setup.options.parent).toBe(control);
    const chromeEvent = { sender: control.webContents, senderFrame: control.frame };
    electron.ipc.get("relaydesk:window:close")!(chromeEvent);
    expect(control.visible).toBe(false);
    expect(setup.visible).toBe(false);
    expect(view.webContents.close).not.toHaveBeenCalled();
    electron.messageBox.mockResolvedValueOnce({ response: 1 });
    electron.trays[0]!.menu!.template.find((item) => item.label === "退出 Codexer Control").click();
    await vi.waitFor(() => expect(control.isDestroyed()).toBe(true));
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(() => electron.ipc.get("relaydesk:window:state")!(chromeEvent)).toThrow(
      "untrusted-sender",
    );
  });
});
