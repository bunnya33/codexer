import { beforeAll, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { resolve } from "node:path";

let javascript = "";
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';
      import {Platform} from 'react-native';
      import {ClientUpdatePanel} from './apps/mobile/src/client-update-panel';
      Platform.OS='android';createRoot(document.getElementById('root')).render(<ClientUpdatePanel/>);`,
      resolveDir: resolve("."),
      loader: "tsx",
    },
    bundle: true,
    outdir: ".local/update-panel-tests",
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    resolveExtensions: [".web.tsx", ".web.ts", ".tsx", ".ts", ".js", ".json"],
    alias: { "react-native": "react-native-web" },
    nodePaths: [resolve("apps/mobile/node_modules")],
    define: { "process.env.NODE_ENV": '"production"', __DEV__: "false", global: "globalThis" },
    plugins: [
      {
        name: "update-fixture",
        setup(bundler) {
          bundler.onResolve({ filter: /^\.\/client-updates$/ }, () => ({
            path: "updates",
            namespace: "fixture",
          }));
          bundler.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            contents: `export function useClientUpdates(){return {version:'0.1.6',available:true,release:{version:'0.1.7'},check:async()=>{},download:(...args)=>window.downloadUpdate(...args)}}`,
          }));
        },
      },
    ],
  });
  javascript = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
});
async function fixture() {
  let progress!: (value: number) => void,
    phase!: (value: string) => void,
    finish!: (value: string) => void;
  const download = vi.fn((_signal, onProgress, onPhase) => {
    progress = onProgress;
    phase = onPhase;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://fixture.test",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as unknown as { downloadUpdate: typeof download }).downloadUpdate = download;
    },
  });
  dom.window.eval(javascript);
  const button = () =>
    [...dom.window.document.querySelectorAll<HTMLElement>('[role="button"]')].find(
      (item) => item.textContent === "下载更新" || item.textContent === "重试安装",
    )!;
  await vi.waitFor(() => expect(button()).toBeDefined());
  return {
    dom,
    download,
    button,
    progress: (value: number) => progress(value),
    phase: (value: string) => phase(value),
    finish: (value: string) => finish(value),
  };
}
it("shows verification and installer launch separately from download completion, then releases the busy state", async () => {
  const test = await fixture();
  const text = () => test.dom.window.document.body.textContent;
  try {
    test.button().click();
    test.button()?.click();
    expect(test.download).toHaveBeenCalledOnce();
    test.progress(1);
    await vi.waitFor(() => expect(text()).toContain("下载完成，正在准备校验"));
    expect(text()).not.toContain("正在下载 100%");
    test.phase("verifying");
    await vi.waitFor(() => expect(text()).toContain("正在校验安装包"));
    test.phase("installing");
    await vi.waitFor(() => expect(text()).toContain("正在打开安装程序"));
    test.finish("opened");
    await vi.waitFor(() => expect(text()).toContain("已打开系统安装程序"));
    expect(test.button().getAttribute("aria-disabled")).not.toBe("true");
    expect(text()).not.toContain("取消更新");
  } finally {
    test.dom.window.close();
  }
});
it("explains installation-source approval and allows retry after returning from settings", async () => {
  const test = await fixture();
  try {
    test.button().click();
    test.finish("permission-required");
    await vi.waitFor(() =>
      expect(test.dom.window.document.body.textContent).toContain("安装包已保留"),
    );
    expect(test.button().textContent).toBe("重试安装");
    test.button().click();
    expect(test.download).toHaveBeenCalledTimes(2);
    test.finish("opened");
  } finally {
    test.dom.window.close();
  }
});
