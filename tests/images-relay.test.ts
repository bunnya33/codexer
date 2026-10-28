import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PcAgent } from "../apps/pc-agent/src/agent.js";
import { testAccount, testAgent } from "./account-helpers.js";
import { createRelay, RelayStore } from "./go-relay.js";
import { FakeDesktop, waitFor } from "./helpers.js";

it("serves assistant Markdown pictures with encoded local paths through the PC Agent and Relay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexer-images-relay-"));
  const desktop = new FakeDesktop();
  const store = await RelayStore.open();
  const account = await testAccount(store), other = await testAccount(store, "Other");
  const app = await createRelay({ store });
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
  let agent: PcAgent | undefined;
  try {
    const paths = [join(directory, "截图 100%.png"), join(directory, "生成的 图片.png")].map(path => path.replaceAll("\\", "/"));
    for (const path of paths) await writeFile(path, bytes);
    const citations = paths.map((path, index) => index === 1 && process.platform === "win32" ? "/" + path : path);
    const history = desktop.state.turnHistory as { history: { entitiesByKey: Record<string, { items: unknown[] }> } };
    history.history.entitiesByKey["turn-key"]!.items = [{
      id: "answer", type: "agentMessage", phase: "final_answer",
      text: citations.map(path => `![图片](<${path}>)`).join("\n\n"),
    }];
    await desktop.start();
    const base = await app.listen({ port: 0 }), registered = await testAgent(store, account.id);
    const reader = {
      list: async () => ({ protocolVersion: 1 as const, deviceId: registered.id, generatedAt: Date.now(), projects: [], threads: [{ id: "thread-test", title: "Images", cwd: null, projectId: null, updatedAt: 1, archived: false }] }),
      history: async () => ({ threadId: "thread-test", generatedAt: Date.now(), nextCursor: null, turns: [] }),
    };
    agent = new PcAgent({ relayUrl: base, deviceId: registered.id, session: registered.token, installationId: "test", username: account.name, expiresAt: Date.now() + 60000 }, directory, ["thread-test"], desktop.endpoint, join(directory, "empty"), "desktop", reader);
    await agent.start();
    await waitFor(async () => (await store.snapshot(registered.id))?.threads["thread-test"]?.turns[0]?.items[0]?.images?.length === 2);
    const snapshot = (await store.snapshot(registered.id))!;
    const refs = snapshot.threads["thread-test"]!.turns[0]!.items[0]!.images!;
    for (const image of refs) {
      const endpoint = `/v1/devices/${registered.id}/threads/thread-test/images/${image.id}`;
      expect((await app.inject({ url: endpoint })).statusCode).toBe(401);
      expect((await app.inject({ url: endpoint, headers: other.headers })).statusCode).toBe(404);
      const response = await app.inject({ url: endpoint, headers: account.headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.rawPayload).toEqual(bytes);
    }
    expect(refs.map(image => image.name)).toEqual(["截图 100%.png", "生成的 图片.png"]);
    expect(JSON.stringify(snapshot)).not.toContain(bytes.toString("base64"));
  } finally {
    await agent?.stop(); await app.close(); await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }
});
