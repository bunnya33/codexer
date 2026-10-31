import { beforeAll, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { resolve } from "node:path";

let source = "";
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {AgentSyncSettings} from './apps/admin/src/agent-sync-settings';const root=createRoot(document.getElementById('root'));window.stopPanel=()=>root.unmount();root.render(<AgentSyncSettings/>);`,
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
const wait = (fn: () => void) => vi.waitFor(fn, { timeout: 3000, interval: 10 });
it("loads, validates and persists the runtime preview limit, retaining a failed draft", async () => {
  let limit = 20,
    failure = false;
  const requests: unknown[] = [],
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
          if (path != "/v1/admin/agent-settings") throw Error("unexpected-request");
          if (init.method === "PUT") {
            requests.push(JSON.parse(String(init.body)));
            if (failure)
              return new Response(JSON.stringify({ error: "storage-error" }), { status: 500 });
            limit = JSON.parse(String(init.body)).threadLimit;
          }
          return new Response(JSON.stringify({ threadLimit: limit }));
        },
      });
    },
  });
  try {
    dom.window.eval(source);
    const doc = dom.window.document;
    await wait(() => expect(doc.querySelector("input")?.disabled).toBe(false));
    const input = doc.querySelector("input")!,
      form = doc.querySelector("form")!;
    const edit = async (value: string) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await wait(() => expect(input.value).toBe(value));
    };
    const submit = () =>
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(input.value).toBe("20");
    for (const value of ["0", "31", "1.5"]) {
      await edit(value);
      submit();
      await wait(() =>
        expect(doc.querySelector('[role="alert"]')?.textContent).toContain("1 至 30"),
      );
    }
    expect(requests).toEqual([]);
    await edit("30");
    failure = true;
    submit();
    await wait(() =>
      expect(doc.querySelector('[role="alert"]')?.textContent).toContain("服务器暂时不可用"),
    );
    expect(input.value).toBe("30");
    failure = false;
    submit();
    await wait(() =>
      expect(doc.querySelector('[role="status"]')?.textContent).toContain("已保存并通知在线连接器"),
    );
    expect(limit).toBe(30);
    expect(requests).toEqual([{ threadLimit: 30 }, { threadLimit: 30 }]);
    expect(errors).toEqual([]);
  } finally {
    (dom.window as any).stopPanel();
    dom.window.close();
  }
});
