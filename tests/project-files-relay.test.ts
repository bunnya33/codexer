import { expect, it } from "vitest";
import { createRelay, RelayStore } from "./go-relay";
import { testAccount, testAgent } from "./account-helpers";
import { snapshot, waitFor, WsPeer } from "./helpers";

it("authorizes project browsing, versions streamed downloads and cancels abandoned requests", async () => {
  const store = await RelayStore.open(),
    account = await testAccount(store),
    other = await testAccount(store, "Other"),
    registered = await testAgent(store, account.id),
    app = await createRelay({ store });
  let peer: WsPeer | undefined;
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    peer = await WsPeer.open(base.replace("http:", "ws:") + "/v1/ws/device", {
      authorization: "Bearer " + registered.token,
      "x-device-id": registered.id,
    });
    await peer.wait((m) => m.type === "device.welcome");
    peer.send({ type: "device.snapshot", snapshot: snapshot(registered.id) });
    peer.send({
      type: "device.catalog",
      catalog: {
        protocolVersion: 1,
        deviceId: registered.id,
        generatedAt: Date.now(),
        projects: [
          { id: "p", name: "Project", roots: ["C:/synthetic"], position: 0, updatedAt: 1 },
        ],
        threads: [],
      },
    });
    await waitFor(async () => !!(await store.catalog(registered.id)));
    const url = `/v1/devices/${registered.id}/projects/p/files`,
      query = { operation: "list", rootIndex: 0, path: "" };
    const post = (payload: unknown, headers = account.headers) =>
      app.inject({ method: "POST", url, headers, payload });
    expect((await post(query)).json().error).toBe("project-files-update-required");
    peer.send({ type: "device.capabilities", features: ["project-files"] });
    const used = new Set<string>();
    const next = async () => {
      const m = await peer!.wait(
        (m) => m.type === "project.request" && !used.has(String(m.requestId)),
      );
      used.add(String(m.requestId));
      return m;
    };
    const reply = (m: any, result: any, code: any = null) =>
      peer!.send({ type: "device.project", requestId: m.requestId, projectId: "p", result, code });
    const pending = post(query);
    let m = await next();
    reply(m, {
      kind: "list",
      entries: [{ name: "中文 file.txt", path: "中文 file.txt", kind: "file", size: 7 }],
      nextCursor: null,
    });
    expect((await pending).json().entries[0].name).toBe("中文 file.txt");
    expect((await post(query, other.headers)).statusCode).toBe(404);
    for (const path of ["../escape", "C:/escape", "/escape", "x\\y", "a/../b", "a\tb"])
      expect((await post({ ...query, path })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: url.replace("/p/", "/missing/"),
          headers: account.headers,
          payload: query,
        })
      ).statusCode,
    ).toBe(404);
    const bad = post(query);
    m = await next();
    reply(m, {
      kind: "list",
      entries: [{ name: "escape", path: "../escape", kind: "file", size: 0 }],
    });
    expect((await bad).json().error).toBe("invalid-file-response");
    const version = "a".repeat(64),
      bytes = Buffer.alloc(256 * 1024 + 17, 89);
    const download = app.inject({
      url: url + "/content?rootIndex=0&path=test.bin&version=" + version,
      headers: account.headers,
    });
    for (const offset of [0, 256 * 1024]) {
      m = await Promise.race([
        next(),
        download.then((v) => {
          throw new Error("Download returned early " + v.statusCode + " " + v.body.slice(0, 300));
        }),
      ]);
      expect((m.query as any).offset).toBe(offset);
      reply(m, {
        kind: "file",
        file: {
          name: "test.bin",
          size: bytes.length,
          version,
          offset,
          base64: bytes.subarray(offset, offset + 256 * 1024).toString("base64"),
        },
      });
    }
    const content = await download;
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(bytes);
    expect(content.headers["cache-control"]).toBe("no-store");
    const abort = new AbortController();
    const abandoned = fetch(base + url, {
      method: "POST",
      headers: { ...account.headers, "content-type": "application/json" },
      body: JSON.stringify(query),
      signal: abort.signal,
    }).catch(() => undefined);
    m = await next();
    abort.abort();
    await abandoned;
    await peer.wait((v) => v.type === "project.cancel" && v.requestId === m.requestId);
    expect(JSON.stringify(await store.snapshot(registered.id))).not.toContain("test.bin");
  } finally {
    await peer?.close();
    await app.close();
  }
});
