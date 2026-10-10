import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import type {
  DeviceSnapshot,
  DeviceCatalog,
  RemoteEvent,
  RemoteCommand,
  CommandResult,
} from "../packages/protocol/src/index.js";
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
type Principal = { id: string; kind: "user" | "admin"; sessionHash?: string; expiresAt?: number };
export class RelayStore {
  private child = spawn(
    resolve(process.platform === "win32" ? ".local/go-test-driver.exe" : ".local/go-test-driver"),
    [],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  constructor() {
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const v = JSON.parse(line),
        p = this.pending.get(v.id);
      if (!p) return;
      this.pending.delete(v.id);
      if (v.error) p.reject(new Error(v.error));
      else p.resolve(v.value);
    });
    this.child.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("Go test driver exited"));
      this.pending.clear();
    });
  }
  rpc<T = any>(method: string, ...args: any[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
    });
  }
  static async open(url?: string, directory?: string) {
    const s = new RelayStore();
    try {
      await s.rpc("open", url ?? "", directory ?? "");
      return s;
    } catch (error) {
      s.child.stdin.end();
      throw error;
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.rpc("close");
    this.child.stdin.end();
  }
  createUser(name: string, password: string, role = "user") {
    return this.rpc<{ id: string; name: string; role: "user" | "admin" }>(
      "createUser",
      name,
      password,
      role,
    );
  }
  createSession(id: string, device?: string) {
    return this.rpc<{ session: string; expiresAt: number }>("createSession", id, device ?? "");
  }
  registerAgent(user: string, installation: string, name: string, platform: string) {
    return this.rpc<string>("registerAgent", user, installation, name, platform);
  }
  sessionPrincipal(session: string, device?: string) {
    return this.rpc<Principal | null>("sessionPrincipal", session, device ?? "");
  }
  checkPassword(name: string, password: string, role = "user") {
    return this.rpc<Principal | null>("checkPassword", name, password, role);
  }
  authorizeDevice(device: string, session: string) {
    return this.rpc<boolean>("authorizeDevice", device, session);
  }
  ticket(principal: Principal) {
    return this.rpc<{ ticket: string; expiresAt: number }>("ticket", principal);
  }
  consumeTicket(ticket: string) {
    return this.rpc<Principal | null>("consumeTicket", ticket);
  }
  listUsers(role = "user") {
    return this.rpc<
      {
        id: string;
        name: string;
        role: string;
        revoked_at: number | null;
        login_enabled: boolean;
      }[]
    >("listUsers", role);
  }
  resetPassword(id: string, password: string, role = "user") {
    return this.rpc<boolean>("resetPassword", id, password, role);
  }
  revokeUser(id: string, role = "user", actor?: string) {
    return this.rpc<boolean>("revokeUser", id, role, actor ?? "");
  }
  ownsDevice(id: string, p: Principal) {
    return this.rpc<boolean>("ownsDevice", id, p);
  }
  listDevices(p: Principal) {
    return this.rpc<Record<string, unknown>[]>("listDevices", p);
  }
  revoke(id: string) {
    return this.rpc("revoke", id);
  }
  snapshot(id: string) {
    return this.rpc<DeviceSnapshot | null>("snapshot", id);
  }
  snapshotMetadata(id: string) {
    return this.rpc<Omit<DeviceSnapshot, "threads"> | null>("snapshotMetadata", id);
  }
  saveSnapshot(value: DeviceSnapshot) {
    return this.rpc("saveSnapshot", value);
  }
  catalog(id: string) {
    return this.rpc<DeviceCatalog | null>("catalog", id);
  }
  saveCatalog(value: DeviceCatalog) {
    return this.rpc("saveCatalog", value);
  }
  saveEvent(value: RemoteEvent) {
    return this.rpc("saveEvent", value);
  }
  replay(id: string, epoch: string, seq: number) {
    return this.rpc<RemoteEvent[] | null>("replay", id, epoch, seq);
  }
  command(id: string, cid: string) {
    return this.rpc<{ status: string; result: CommandResult | null; payload_hash: string } | null>(
      "command",
      id,
      cid,
    );
  }
  addCommand(c: RemoteCommand) {
    return this.rpc("addCommand", c);
  }
  finishCommand(value: CommandResult) {
    return this.rpc<boolean>("finishCommand", value);
  }
  authSettings() {
    return this.rpc<{ idleTimeoutMinutes: number }>("authSettings");
  }
  setAuthSettings(value: { idleTimeoutMinutes: number }) {
    return this.rpc("setAuthSettings", value);
  }
  query(sql: string, args: unknown[] = []) {
    return this.rpc<{ rows: Record<string, unknown>[] }>("query", sql, args);
  }
  touchSession(h: string) {
    return this.rpc("touchSession", h);
  }
}
export async function createRelay(options: {
  store: RelayStore;
  allowedOrigins?: string[];
  webRoot?: string;
  adminRoot?: string;
  heartbeatMs?: number;
  cleanupMs?: number;
  version?: string;
}) {
  const { store, ...config } = options;
  let base: string | undefined;
  const start = async (opts?: any) =>
    (base ??= await store.rpc<string>("server", { ...config, ...opts }));
  return {
    listen: async (opts?: any) => {
      if (base && opts?.port && Number(new URL(base).port) !== opts.port) {
        base = await store.rpc<string>("listen", opts.port);
      }
      return start(opts);
    },
    close: () => store.close(),
    inject: async (input: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      payload?: unknown;
      remoteAddress?: string;
    }) => {
      const headers = { ...input.headers };
      let body: string | undefined;
      if (input.payload !== undefined) {
        body = typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload);
        headers["content-type"] ??= "application/json";
      }
      const origin = await start();
      return await new Promise<any>((done, reject) => {
        const req = httpRequest(
          origin + input.url,
          { method: input.method ?? "GET", headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (v) => chunks.push(v));
            res.on("end", () => {
              const rawPayload = Buffer.concat(chunks);
              done({
                statusCode: res.statusCode,
                headers: res.headers,
                body: rawPayload.toString(),
                rawPayload,
                json: () => JSON.parse(rawPayload.toString()),
              });
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    },
  };
}
