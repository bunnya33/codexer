import { beforeAll, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { resolve } from "node:path";
import type { ClientRelease } from "../packages/shared/src/client-release";

let source = "";
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {ClientReleases} from './apps/admin/src/client-releases';const root=createRoot(document.getElementById('root'));window.stopPanel=()=>root.unmount();root.render(<ClientReleases/>);`,
      resolveDir: resolve("."),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  source = result.outputFiles[0]!.text;
});
const release = (
  id: string,
  version: string,
  target: ClientRelease["target"] = "agent-windows-x64-setup",
): ClientRelease => ({
  id,
  version,
  target,
  name: target === "control-android" ? "Control.apk" : "Agent.exe",
  buildNumber: target === "control-android" ? 4 : 0,
  notes: "更新说明",
  size: 1024 ** 2,
  sha256: "a".repeat(64),
  uploadedAt: 1000,
});
const first = release("88e8ccfe-945b-4254-a227-99c5d3449691", "0.2.12");
const second = release("88e8ccfe-945b-4254-a227-99c5d3449692", "0.2.13");
const android = release("88e8ccfe-945b-4254-a227-99c5d3449693", "0.1.3", "control-android");
const wait = (fn: () => void) => vi.waitFor(fn, { timeout: 3000, interval: 10 });
async function fixture(initial: ClientRelease[] = [second, first, android]) {
  let packages = [...initial],
    failDelete = false,
    failList = false;
  const current = Object.fromEntries(
    initial.filter((v) => v.id !== first.id).map((v) => [v.target, v]),
  );
  const requests: { path: string; method?: string }[] = [],
    errors: unknown[] = [];
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://admin.test/admin/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.localStorage.setItem("codexer.admin.session.v2", "fixture-admin");
      w.addEventListener("error", (e) => errors.push(e.error));
      Object.assign(w, {
        AbortController,
        AbortSignal,
        fetch: async (path: string, init: RequestInit) => {
          requests.push({ path, method: init.method });
          if (path === "/v1/admin/client-releases" && init.method === "GET")
            return new Response(
              JSON.stringify(failList ? { error: "unavailable" } : { releases: current, packages }),
              { status: failList ? 500 : 200 },
            );
          if (path.startsWith("/v1/admin/client-releases/") && init.method === "DELETE") {
            if (failDelete)
              return new Response(JSON.stringify({ error: "client-release-in-use" }), {
                status: 409,
              });
            const id = path.split("/").at(-1)!;
            const found = packages.find((v) => v.id === id)!;
            packages = packages.filter((v) => v.id !== id);
            if (current[found.target]?.id === id) delete current[found.target];
            return new Response(JSON.stringify({ ok: true }));
          }
          throw Error(`unexpected-request:${path}`);
        },
      });
    },
  });
  dom.window.eval(source);
  await wait(() =>
    expect(dom.window.document.body.textContent).toContain(`共 ${initial.length} 个安装包`),
  );
  const doc = dom.window.document;
  const click = (label: string) => {
    const button = [...doc.querySelectorAll<HTMLButtonElement>("button")].find(
      (v) => v.textContent === label || v.getAttribute("aria-label") === label,
    );
    expect(button, label).toBeDefined();
    button!.click();
  };
  const select = async (label: string, value: string) => {
    const input = doc.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
    input.value = value;
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait(() => expect(input.value).toBe(value));
  };
  return {
    dom,
    doc,
    click,
    select,
    requests,
    errors,
    setDeleteFailure(value: boolean) {
      failDelete = value;
    },
    setListFailure(value: boolean) {
      failList = value;
    },
    close() {
      (dom.window as any).stopPanel();
      dom.window.close();
    },
  };
}

it("lists package sizes, versions, status and details, and filters history by platform", async () => {
  const f = await fixture();
  try {
    await wait(() => expect(f.doc.querySelectorAll("tbody tr")).toHaveLength(3));
    expect(f.doc.body.textContent).toContain("3 MiB");
    expect(f.doc.querySelector("tbody")!.textContent).toContain("历史版本");
    expect(f.doc.querySelector("code")!.textContent).toBe("a".repeat(64));
    await f.select("筛选安装包状态", "history");
    await wait(() => expect(f.doc.querySelectorAll("tbody tr")).toHaveLength(1));
    expect(f.doc.querySelector("tbody")!.textContent).toContain("0.2.12");
    await f.select("筛选客户端平台", "control-android");
    await wait(() => expect(f.doc.body.textContent).toContain("没有符合筛选条件的安装包"));
    await f.select("筛选安装包状态", "current");
    await wait(() => expect(f.doc.querySelector("tbody")!.textContent).toContain("构建 4"));
    expect(f.errors).toEqual([]);
  } finally {
    f.close();
  }
});

it("requires confirmation, preserves a busy download on failure, retries and removes history", async () => {
  const f = await fixture();
  try {
    f.click("删除 Agent.exe 0.2.12");
    await wait(() =>
      expect(f.doc.querySelector('[role="dialog"]')?.textContent).toContain("删除历史安装包"),
    );
    f.click("取消");
    await wait(() => expect(f.doc.querySelector('[role="dialog"]')).toBeNull());
    expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    f.click("删除 Agent.exe 0.2.12");
    await wait(() => expect(f.doc.querySelector('[role="dialog"]')).not.toBeNull());
    f.setDeleteFailure(true);
    f.click("确认删除");
    await wait(() =>
      expect(f.doc.querySelector('[role="alert"]')?.textContent).toContain("安装包正在下载"),
    );
    expect(f.doc.querySelectorAll("tbody tr")).toHaveLength(3);
    f.setDeleteFailure(false);
    f.click("确认删除");
    await wait(() => expect(f.doc.querySelector('[role="dialog"]')).toBeNull());
    await wait(() => expect(f.doc.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(f.doc.body.textContent).toContain("释放 1 MiB");
    expect(f.doc.querySelector("tbody")!.textContent).toContain("0.2.13");
    expect(f.errors).toEqual([]);
  } finally {
    f.close();
  }
});

it("warns before unpublishing the current package without selecting an old version", async () => {
  const f = await fixture();
  try {
    f.click("删除 Agent.exe 0.2.13");
    await wait(() =>
      expect(f.doc.querySelector('[role="dialog"]')?.textContent).toContain(
        "不会自动回退到历史版本",
      ),
    );
    f.click("确认删除");
    await wait(() => expect(f.doc.querySelector('[role="dialog"]')).toBeNull());
    await f.select("筛选安装包状态", "current");
    await wait(() => expect(f.doc.querySelectorAll("tbody tr")).toHaveLength(1));
    expect(f.doc.querySelector("tbody")!.textContent).toContain("Android");
    expect(f.doc.body.textContent).toContain("尚未发布此客户端");
    expect(f.errors).toEqual([]);
  } finally {
    f.close();
  }
});

it("renders empty state and allows retry after a list error", async () => {
  const f = await fixture([]);
  try {
    await wait(() => expect(f.doc.body.textContent).toContain("尚未上传客户端安装包"));
    f.setListFailure(true);
    f.click("刷新列表");
    await wait(() => expect(f.doc.body.textContent).toContain("客户端版本读取失败"));
    f.setListFailure(false);
    f.click("刷新列表");
    await wait(() => expect(f.doc.querySelector('[role="status"]')).toBeNull());
    expect(f.errors).toEqual([]);
  } finally {
    f.close();
  }
});
