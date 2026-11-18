import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { beforeAll, expect, it, vi } from "vitest";
import { resolve } from "node:path";

let javascript = "";
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';
        import {Alert} from 'react-native';
        import {OtaUpdatePanel} from './apps/mobile/src/ota-update-panel.mobile';
        Alert.alert = (...args) => window.onAlert(...args);
        createRoot(document.getElementById('root')).render(<OtaUpdatePanel/>);`,
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
  javascript = result.outputFiles[0].text;
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
      Object.assign(window, { onAlert, updates, relay });
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
  await click("检查内容更新");
  return {
    dom,
    click,
    updates,
    onAlert,
    relay,
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
    onAlert.mock.calls[0][2][0].onPress();
    await click("应用已下载更新");
    await vi.waitFor(() => expect(onAlert).toHaveBeenCalledTimes(2));
    onAlert.mock.calls[1][3].onDismiss();
    await click("应用已下载更新");
    await vi.waitFor(() => expect(onAlert).toHaveBeenCalledTimes(3));
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    const buttons = onAlert.mock.calls[2][2];
    expect(buttons.map((button) => button.text)).toEqual(["下次启动", "立即重启"]);
    buttons[1].onPress();
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
    const priorButton = Array.from(dom.window.document.querySelectorAll('[role="button"]')).find(
      (item) => item.textContent === "检查内容更新",
    );
    expect(priorButton).toBeDefined();
    relay.mobileOtaVersion.mockResolvedValue(null);
    switchRelay("http://second.test:8787");
    await vi.waitFor(() => expect(priorButton!.isConnected).toBe(false));
    await click("检查内容更新");
    await vi.waitFor(() =>
      expect(dom.window.document.body.textContent).toContain("当前服务器暂不支持内容更新"),
    );
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
