import { beforeAll, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { resolve } from "node:path";

let source = "";
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {PublishingPanel} from './apps/admin/src/publishing';const root=createRoot(document.getElementById('root'));window.stopPanel=()=>root.unmount();root.render(<PublishingPanel/>);`,
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
it("generates a code once, copies on HTTP without Clipboard API, and clears it on close", async () => {
  const code = "cdxp_k_" + "K".repeat(43),
    requests: { path: string; method?: string; body: unknown }[] = [];
  let created = false,
    copied = "";
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://admin.test/admin/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.localStorage.setItem("codexer.admin.session.v2", "fixture-admin");
      Object.assign(w.document, {
        execCommand: (command: string) => {
          expect(command).toBe("copy");
          copied = (w.document.activeElement as HTMLTextAreaElement).value;
          return true;
        },
      });
      Object.assign(w, {
        AbortController,
        AbortSignal,
        fetch: async (path: string, init: RequestInit) => {
          requests.push({
            path,
            method: init.method,
            body: init.body ? JSON.parse(String(init.body)) : null,
          });
          if (path === "/v1/admin/publishing/keys" && init.method === "POST") {
            created = true;
            return new Response(
              JSON.stringify({
                code,
                name: "Release PC",
                grantId: "key-id",
                username: "admin",
                scopes: ["server:read"],
                expiresAt: Date.now() + 86400000,
              }),
            );
          }
          if (path === "/v1/admin/publishing")
            return new Response(
              JSON.stringify({
                grants: created
                  ? [
                      {
                        id: "key-id",
                        name: "Release PC",
                        username: "admin",
                        scopes: "server:read",
                        credential_type: "key",
                        created_at: Date.now(),
                        expires_at: Date.now() + 86400000,
                        last_used_at: Date.now() - 31 * 86400000,
                        revoked_at: null,
                      },
                    ]
                  : [],
                audit: [],
              }),
            );
          throw Error("unexpected request");
        },
      });
    },
  });
  try {
    dom.window.eval(source);
    const doc = dom.window.document;
    const button = (text: string) =>
      [...doc.querySelectorAll("button")].find((v) => v.textContent === text)!;
    await wait(() => expect(doc.body.textContent).toContain("暂无发布授权"));
    button("生成发布授权码").click();
    await wait(() => expect(doc.querySelector('[role="dialog"]')).not.toBeNull());
    const name = doc.querySelector(
      '[role="dialog"] input:not([type="checkbox"])',
    ) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(
      name,
      "Release PC",
    );
    name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await wait(() => expect(name.value).toBe("Release PC"));
    const form = doc.querySelector('[role="dialog"] form')!;
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await wait(() => expect(doc.querySelector("textarea")?.value).toBe(code));
    button("复制授权码").click();
    await wait(() => expect(copied).toBe(code));
    expect(requests.filter((r) => r.path.endsWith("/keys"))).toHaveLength(1);
    expect(requests.find((r) => r.path.endsWith("/keys"))?.body).toMatchObject({
      name: "Release PC",
      expiresInDays: 90,
    });
    expect(dom.window.localStorage.length).toBe(1);
    expect(dom.window.sessionStorage.length).toBe(0);
    button("已保存，关闭").click();
    await wait(() => expect(doc.querySelector('[role="dialog"]')).toBeNull());
    await wait(() => expect(doc.querySelector("tbody")?.textContent).toContain("有效"));
    expect(doc.documentElement.outerHTML).not.toContain(code);
    button("刷新").click();
    button("生成发布授权码").click();
    await wait(() => expect(doc.querySelector('[role="dialog"] form')).not.toBeNull());
    expect(doc.querySelector("textarea")).toBeNull();
    expect(doc.documentElement.outerHTML).not.toContain(code);
    expect(JSON.stringify(requests)).not.toContain(code);
  } finally {
    (dom.window as any).stopPanel();
    dom.window.close();
  }
});
