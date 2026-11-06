import { beforeAll, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { resolve } from "node:path";

const archiveName = "codexer-server-0.3.39-linux-amd64.tar.gz",
  hash = "a".repeat(64);
let source = "";
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import{useState}from'react';import{createRoot}from'react-dom/client';import{ServerUpdateUpload}from'./apps/admin/src/server-update-upload';function App(){const[busy,setBusy]=useState(false);return <ServerUpdateUpload version={window.fixtureVersion} busy={busy} setBusy={setBusy} onPrepared={job=>window.prepared.push(job)} onUnauthorized={()=>window.unauthorized=true}/>;}const root=createRoot(document.getElementById('root'));window.stopPanel=()=>root.unmount();root.render(<App/>);`,
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
async function fixture(overrides: Record<string, unknown> = {}) {
  let hold = false,
    status = 200;
  const requests: { method: string; url: string; file: File; headers: Record<string, string> }[] =
    [];
  const errors: unknown[] = [];
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://admin.test/admin/",
    runScripts: "dangerously",
    beforeParse(w) {
      w.localStorage.setItem("codexer.admin.session.v2", "fixture-admin");
      w.addEventListener("error", (e) => errors.push(e.error));
      Object.assign(w, {
        fixtureVersion: {
          currentVersion: "0.3.38",
          platform: "linux-amd64",
          supported: true,
          uploadSupported: true,
          ...overrides,
        },
        prepared: [],
        unauthorized: false,
        AbortController,
        AbortSignal,
        XMLHttpRequest: class {
          method = "";
          url = "";
          headers: Record<string, string> = {};
          timeout = 0;
          upload: { onprogress?: (e: unknown) => void } = {};
          onload?: () => void;
          onabort?: () => void;
          status = 0;
          responseText = "";
          open(method: string, url: string) {
            this.method = method;
            this.url = url;
          }
          setRequestHeader(k: string, v: string) {
            this.headers[k] = v;
          }
          send(file: File) {
            requests.push({ method: this.method, url: this.url, file, headers: this.headers });
            this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
            if (hold) return;
            this.status = status;
            this.responseText = JSON.stringify(
              status === 200
                ? {
                    id: "12345678-1234-1234-1234-123456789abc",
                    tag: "v0.3.39",
                    source: "upload",
                    method: "release",
                    action: "update",
                    phase: "queued",
                    updatedAt: 1,
                  }
                : { error: "checksum-mismatch" },
            );
            queueMicrotask(() => this.onload?.());
          }
          abort() {
            this.onabort?.();
          }
        },
      });
    },
  });
  dom.window.eval(source);
  await wait(() => expect(dom.window.document.body.textContent).toContain("手动上传服务器更新包"));
  const doc = dom.window.document,
    state = dom.window as unknown as { prepared: unknown[]; unauthorized: boolean };
  const file = (name: string, text = "x".repeat(256)) => {
    const value = new dom.window.File([text], name);
    Object.defineProperty(value, "text", { value: async () => text });
    return value;
  };
  const select = async (files: File[], drop = true) => {
    const input = doc.querySelector<HTMLInputElement>("input[type=file]")!;
    const event = new dom.window.Event(drop ? "drop" : "change", {
      bubbles: true,
      cancelable: true,
    });
    if (drop) {
      Object.defineProperty(event, "dataTransfer", { value: { files } });
      doc.querySelector(".installer-dropzone")!.dispatchEvent(event);
    } else {
      Object.defineProperty(input, "files", { value: files, configurable: true });
      input.dispatchEvent(event);
    }
    await wait(() => expect(doc.body.textContent).toContain(files[0]!.name));
  };
  const click = (text: string) => {
    const b = [...doc.querySelectorAll("button")].find((b) => b.textContent === text);
    expect(b).toBeDefined();
    b!.click();
  };
  return {
    dom,
    doc,
    file,
    select,
    click,
    requests,
    state,
    errors,
    setHold(v: boolean) {
      hold = v;
    },
    setStatus(v: number) {
      status = v;
    },
    close() {
      (dom.window as any).stopPanel();
      dom.window.close();
    },
  };
}

it("detects a dropped server version and uploads the checked pair without restarting or checking GitHub", async () => {
  const f = await fixture();
  try {
    await f.select([
      f.file(archiveName),
      f.file(archiveName + ".sha256", `${hash}  ${archiveName}\n`),
    ]);
    expect(f.doc.body.textContent).toContain("v0.3.39 · linux-amd64");
    expect(f.requests).toHaveLength(0);
    f.click("上传并准备更新");
    await wait(() => expect(f.state.prepared).toHaveLength(1));
    expect(f.requests).toHaveLength(1);
    const request = f.requests[0]!;
    expect(request.method).toBe("PUT");
    expect(new URL(request.url, "http://admin.test").pathname).toBe(
      "/v1/admin/system/update-package",
    );
    const params = new URL(request.url, "http://admin.test").searchParams;
    expect(params.get("name")).toBe(archiveName);
    expect(params.get("sha256")).toBe(hash);
    expect(request.headers.Authorization).toBe("Bearer fixture-admin");
    expect(f.state.prepared[0]).toMatchObject({ phase: "queued", source: "upload" });
    expect(f.errors).toEqual([]);
  } finally {
    f.close();
  }
});

it.each([
  ["codexer-server-0.3.39-linux-arm64.tar.gz", undefined, "linux-amd64"],
  ["codexer-server-0.3.38-linux-amd64.tar.gz", undefined, "高于当前"],
  [archiveName, "not-a-checksum", "校验文件内容"],
  [archiveName, `${hash}  wrong.tar.gz`, "不匹配"],
])("rejects invalid package or checksum selection %s", async (name, text, message) => {
  const f = await fixture();
  try {
    await f.select([f.file(name), f.file(name + ".sha256", text ?? `${hash}  ${name}`)], false);
    f.click("上传并准备更新");
    await wait(() => expect(f.doc.querySelector("[role=alert]")?.textContent).toContain(message));
    expect(f.requests).toHaveLength(0);
  } finally {
    f.close();
  }
});

it("keeps a cancelled upload available to retry and clears it after preparation", async () => {
  const f = await fixture();
  try {
    await f.select([
      f.file(archiveName),
      f.file(archiveName + ".sha256", `${hash}  ${archiveName}`),
    ]);
    f.setHold(true);
    f.click("上传并准备更新");
    await wait(() => expect(f.requests).toHaveLength(1));
    f.click("取消上传");
    await wait(() => expect(f.doc.querySelector("progress")).toBeNull());
    expect(f.state.prepared).toHaveLength(0);
    expect(f.doc.body.textContent).toContain(archiveName);
    f.setHold(false);
    f.click("上传并准备更新");
    await wait(() => expect(f.state.prepared).toHaveLength(1));
    expect(f.requests).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally {
    f.close();
  }
});

it("explains the one-time helper upgrade and hides uploads on an old updater", async () => {
  const f = await fixture({ uploadSupported: false });
  try {
    expect(f.doc.body.textContent).toContain("sudo bash install.sh");
    expect(f.doc.querySelector("input[type=file]")).toBeNull();
  } finally {
    f.close();
  }
});

it("returns an expired administrator to login after an upload", async () => {
  const f = await fixture();
  try {
    await f.select([
      f.file(archiveName),
      f.file(archiveName + ".sha256", `${hash}  ${archiveName}`),
    ]);
    f.setStatus(401);
    f.click("上传并准备更新");
    await wait(() => expect(f.state.unauthorized).toBe(true));
    expect(f.dom.window.localStorage.getItem("codexer.admin.session.v2")).toBeNull();
  } finally {
    f.close();
  }
});
