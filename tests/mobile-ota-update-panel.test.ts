import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { beforeAll, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";

let javascript = "";
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';
        import {Alert, AppState} from 'react-native';
        import {OtaUpdatePanel, OtaUpdateProvider, useOtaUpdateAvailable} from './apps/mobile/src/ota-update-panel.mobile';
        Alert.alert = (...args) => window.onAlert(...args);
        Object.defineProperty(AppState, 'currentState', { get: () => window.appState.currentState });
        AppState.addEventListener = (...args) => window.appState.addEventListener(...args);
        function Screen() {
          return <>{useOtaUpdateAvailable() && <span aria-label="有热更新"/>}
            <OtaUpdatePanel/></>;
        }
        createRoot(document.getElementById('root')).render(<OtaUpdateProvider><Screen/></OtaUpdateProvider>);`,
      resolveDir: resolve("."),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    resolveExtensions: [".web.tsx", ".web.ts", ".tsx", ".ts", ".js", ".json"],
    loader: { ".css": "empty" },
    alias: { "react-native": "react-native-web" },
    nodePaths: [resolve("apps/mobile/node_modules")],
    define: { "process.env.NODE_ENV": '"production"', __DEV__: "false", global: "globalThis" },
    plugins: [
      {
        name: "expo-updates-fixture",
        setup(bundler) {
          bundler.onResolve({ filter: /^expo-updates$/ }, () => ({
            path: "updates",
            namespace: "fixture",
          }));
          bundler.onResolve({ filter: /^\.\/relay$/ }, () => ({
            path: "relay",
            namespace: "fixture",
          }));
          bundler.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            contents:
              path === "updates"
                ? "module.exports = window.updates;"
                : "exports.relay = window.relay;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const [output] = result.outputFiles;
  assert.ok(output);
  javascript = output.text;
});

async function fixture() {
  const updates = {
    isEnabled: true,
    useUpdates: () => ({ isUpdatePending: false }),
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: true })),
    fetchUpdateAsync: vi.fn(async () => ({ isNew: true })),
    reloadAsync: vi.fn(async () => {}),
    setUpdateRequestHeadersOverride: vi.fn(),
  };
  const listeners = new Set<() => void>();
  const stateListeners = new Set<(state: string) => void>();
  const appState = {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      stateListeners.add(listener);
      return { remove: () => stateListeners.delete(listener) };
    },
  };
  let onInterval: (() => void) | undefined;
  let view = { phase: "connected", url: "http://first.test:8899", userId: "user" };
  const relay = {
    getSnapshot: () => view,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mobileOtaVersion: vi.fn<() => Promise<string | null>>(async () => "0.3.71"),
  };
  const onAlert =
    vi.fn<
      (
        title: string,
        message: string,
        buttons: { text: string; onPress: () => void }[],
        options: { onDismiss: () => void },
      ) => void
    >();
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://fixture.test",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.assign(window, { onAlert, updates, relay, appState });
      const startInterval = window.setInterval.bind(window);
      const stopInterval = window.clearInterval.bind(window);
      window.setInterval = (callback, interval, ...args) => {
        if (interval !== 5 * 60 * 1000 || typeof callback !== "function")
          return startInterval(callback, interval, ...args);
        onInterval = () => callback(...args);
        return -1;
      };
      window.clearInterval = id => {
        if (id === -1) onInterval = undefined;
        else stopInterval(id);
      };
    },
  });
  dom.window.eval(javascript);
  const click = async (label: string) => {
    const button = await vi.waitFor(() => {
      const match = Array.from(
        dom.window.document.querySelectorAll<HTMLElement>('[role="button"]'),
      ).find((item) => item.textContent === label && item.getAttribute("aria-disabled") !== "true");
      expect(match).toBeDefined();
      return match!;
    });
    button.click();
  };
  await vi.waitFor(() => expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce());
  return {
    dom,
    click,
    updates,
    onAlert,
    relay,
    poll: () => onInterval?.(),
    isPolling: () => !!onInterval,
    setAppState: (state: string) => {
      appState.currentState = state;
      stateListeners.forEach(listener => listener(state));
    },
    switchRelay: (url: string) => {
      view = { ...view, url };
      listeners.forEach((listener) => listener());
    },
  };
}

it("keeps a downloaded update after dismissal and reloads only on confirmation", async () => {
  const { dom, click, updates, onAlert } = await fixture();
  try {
    await click("下载内容更新");
    await vi.waitFor(() => expect(onAlert).toHaveBeenCalledTimes(1));
    const deferButton = onAlert.mock.calls[0]?.[2][0];
    assert.ok(deferButton);
    deferButton.onPress();
    await click("应用已下载更新");
    await vi.waitFor(() => expect(onAlert).toHaveBeenCalledTimes(2));
    const dismiss = onAlert.mock.calls[1]?.[3].onDismiss;
    assert.ok(dismiss);
    dismiss();
    await click("应用已下载更新");
    await vi.waitFor(() => expect(onAlert).toHaveBeenCalledTimes(3));
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    const buttons = onAlert.mock.calls[2]?.[2];
    expect(buttons?.map((button) => button.text)).toEqual(["下次启动", "立即重启"]);
    const restartButton = buttons?.[1];
    assert.ok(restartButton);
    restartButton.onPress();
    await vi.waitFor(() => expect(updates.reloadAsync).toHaveBeenCalledOnce());
  } finally {
    dom.window.close();
  }
});

it("allows retrying a failed download without prompting or reloading", async () => {
  const { dom, click, updates, onAlert } = await fixture();
  try {
    updates.fetchUpdateAsync.mockRejectedValueOnce(new Error("download failed"));
    await click("下载内容更新");
    await vi.waitFor(() =>
      expect(dom.window.document.body.textContent).toContain("内容更新下载失败"),
    );
    expect(onAlert).not.toHaveBeenCalled();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    await click("下载内容更新");
    await vi.waitFor(() => expect(onAlert).toHaveBeenCalledOnce());
  } finally {
    dom.window.close();
  }
});

it("checks the current Relay version and discards the previous server's available update", async () => {
  const { dom, click, updates, relay, switchRelay } = await fixture();
  try {
    await vi.waitFor(() =>
      expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith({
        "frogcoder-update-url": "http://first.test:8899/v1/mobile-ota/manifest?relayVersion=0.3.71",
      }),
    );
    const badge = () => dom.window.document.querySelector('[aria-label="有热更新"]');
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    relay.mobileOtaVersion.mockResolvedValue(null);
    switchRelay("http://second.test:8787");
    await vi.waitFor(() =>
      expect(dom.window.document.body.textContent).toContain("当前服务器暂不支持内容更新"),
    );
    expect(badge()).toBeNull();
    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    relay.mobileOtaVersion.mockResolvedValue("0.3.72");
    await click("检查内容更新");
    await vi.waitFor(() =>
      expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith({
        "frogcoder-update-url":
          "http://second.test:8787/v1/mobile-ota/manifest?relayVersion=0.3.72",
      }),
    );
  } finally {
    dom.window.close();
  }
});

it("checks on launch, foreground return and every five minutes while foregrounded", async () => {
  const { dom, updates, setAppState, isPolling, poll } = await fixture();
  const badge = () => dom.window.document.querySelector('[aria-label="有热更新"]');
  try {
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(isPolling()).toBe(true);
    setAppState("background");
    expect(isPolling()).toBe(false);
    poll();
    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    setAppState("active");
    await vi.waitFor(() => expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(2));
    updates.checkForUpdateAsync.mockResolvedValueOnce({ isAvailable: false });
    poll();
    await vi.waitFor(() => expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(badge()).toBeNull());
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});
