import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommandJournal } from "../apps/pc-agent/src/journal.js";
import { validateRelayUrl } from "../apps/pc-agent/src/auth.js";
import { readSecret, writeSecret } from "../packages/shared/src/secrets.js";
import { command } from "./helpers.js";

describe("durable command outcomes", () => {
  it("returns the stored outcome and refuses reused IDs with changed payloads", () => {
    const journal = new CommandJournal(":memory:");
    try {
      const input = command({ type: "turn.start", threadId: "thread-test", text: "test" });
      expect(journal.lookup(input)).toBeNull();
      journal.begin(input);
      const result = { deviceId: input.deviceId, commandId: input.commandId, status: "succeeded" as const, code: "ok" };
      journal.finish(result);
      expect(journal.lookup(input)).toEqual(result);
      expect(journal.lookup({ ...input, payload: { ...input.payload, type: "turn.start", threadId: "thread-test", text: "different" } })).toMatchObject({ status: "failed", code: "command-id-reused" });
    } finally { journal.close(); }
  });
  it("does not re-execute a command with an unconfirmed outcome after a crash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-remote-journal-"));
    const input = command({ type: "turn.start", threadId: "thread-test", text: "test" });
    const path = join(directory, "journal.sqlite");
    let journal = new CommandJournal(path);
    try {
      journal.begin(input); journal.close();
      journal = new CommandJournal(path);
      expect(journal.lookup(input)).toMatchObject({ status: "unknown", code: "agent-outcome-unconfirmed" });
    } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps device and command IDs distinct even when they contain colons", () => {
    const journal = new CommandJournal(":memory:");
    try {
      const input = { ...command({ type: "turn.start", threadId: "thread-test", text: "test" }), deviceId: "a:b", commandId: "c" };
      journal.begin(input);
      expect(journal.lookup({ ...input, deviceId: "a", commandId: "b:c" })).toBeNull();
    } finally { journal.close(); }
  });
  it("persists queued prompts and does not automatically retry an interrupted send", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-remote-queue-"));
    const path = join(directory, "journal.sqlite");
    let journal = new CommandJournal(path);
    try {
      journal.enqueue({ id: "queued-1", threadId: "thread-a", text: "Continue", images: ["image-1"], createdAt: 100, status: "queued" });
      journal.enqueue({ id: "queued-2", threadId: "thread-a", text: "Check", images: [], createdAt: 200, status: "sending" });
      journal.close();
      journal = new CommandJournal(path);
      expect(journal.queued("thread-a")).toMatchObject([{ id: "queued-1", text: "Continue", images: ["image-1"], status: "queued" }, { id: "queued-2", status: "failed" }]);
      journal.removeQueued("queued-2");
      expect(journal.queued("thread-a").map(value => value.id)).toEqual(["queued-1"]);
    } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe("local credentials", () => {
  it("round trips the independent device secret through the operating-system store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-remote-secret-"));
    try {
      const value = { deviceToken: "test-only-independent-token", label: "\u6d4b\u8bd5" };
      await writeSecret(join(directory, "token.secret"), value);
      expect(await readSecret(join(directory, "token.secret"))).toEqual(value);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("requires HTTPS outside loopback and rejects embedded credentials or paths", () => {
    expect(validateRelayUrl("https://remote.example.test", false).protocol).toBe("https:");
    expect(validateRelayUrl("http://127.0.0.1:8787", false).hostname).toBe("127.0.0.1");
    for (const url of ["http://remote.example.test", "https://user:secret@remote.example.test", "https://remote.example.test/?token=abc", "https://remote.example.test/ignored-path"]) expect(() => validateRelayUrl(url, false)).toThrow();
  });
  it("allows an explicit HTTP endpoint and port without accepting other unsafe URL forms", () => {
    const url = validateRelayUrl("http://192.0.2.10:8899", true);
    expect(url.origin).toBe("http://192.0.2.10:8899");
    for (const url of ["ftp://remote.example.test", "ws://remote.example.test", "http://user:secret@remote.example.test", "http://remote.example.test/?token=abc", "http://remote.example.test/#secret", "http://remote.example.test/ignored-path"]) expect(() => validateRelayUrl(url, true)).toThrow();
  });
  it("requires the exact HTTP opt-in value in the agent account login", () => {
    try {
      vi.stubEnv("CODEX_REMOTE_ALLOW_HTTP", "1");
      expect(validateRelayUrl("http://remote.example.test:8899").port).toBe("8899");
      vi.stubEnv("CODEX_REMOTE_ALLOW_HTTP", "0");
      expect(() => validateRelayUrl("http://remote.example.test:8899")).toThrow("relay-http-requires");
    } finally { vi.unstubAllEnvs(); }
  });
});
