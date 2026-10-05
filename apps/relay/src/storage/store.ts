import type { AuthSettings } from "../../../../packages/shared/src/session-policy.js";
import type {
  CommandResult,
  DeviceCatalog,
  DeviceSnapshot,
  ImagePayload,
  RemoteCommand,
  RemoteEvent,
} from "../../../../packages/protocol/src/index.js";
import { AccountRepository } from "../auth/accounts.js";
import { SessionRepository } from "../auth/sessions.js";
import type { Principal } from "../auth/types.js";
import { DeviceRepository } from "../devices/repository.js";
import { CommandRepository } from "../commands/repository.js";
import { ImageRepository } from "../images/repository.js";
import { SyncRepository } from "../sync/repository.js";
import type { SnapshotMetadata } from "../sync/repository.js";
import { WeixinStore } from "../weixin/repository.js";
import { openDatabase } from "./database.js";
import { migrateDatabase } from "./migrations.js";
import { cleanupStorage } from "./maintenance.js";
import type { Database, Row } from "./types.js";
import { performance } from "node:perf_hooks";
import { RelayMetrics } from "../observability/metrics.js";
import type { CleanupOptions, CleanupSummary } from "./batch-cleanup.js";

export { hash } from "../auth/hash.js";
export type { Principal } from "../auth/types.js";

/** 存储门面保持调用方式稳定；SQL 与事务语义由各功能的 repository 负责。 */
export class RelayStore {
  readonly weixin: WeixinStore;
  private readonly accounts: AccountRepository;
  private readonly sessions: SessionRepository;
  private readonly devices: DeviceRepository;
  private readonly commands: CommandRepository;
  private readonly images: ImageRepository;
  private readonly sync: SyncRepository;

  private constructor(
    private readonly database: Database,
    readonly metrics: RelayMetrics,
  ) {
    const { sql, transaction } = database;
    this.weixin = new WeixinStore(sql, transaction);
    this.accounts = new AccountRepository(sql, transaction);
    this.sessions = new SessionRepository(sql, transaction);
    this.devices = new DeviceRepository(sql, transaction, this.sessions);
    this.commands = new CommandRepository(sql);
    this.images = new ImageRepository(sql);
    this.sync = new SyncRepository(sql, transaction, this.weixin);
  }

  static async open(databaseUrl?: string, directory?: string): Promise<RelayStore> {
    const metrics = new RelayMetrics();
    const database = await openDatabase(databaseUrl, directory, metrics);
    try {
      await migrateDatabase(database);
      const store = new RelayStore(database, metrics);
      await store.weixin.initialize();
      return store;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  close(): Promise<void> {
    this.metrics.stop();
    return this.database.close();
  }

  createUser(
    name: string,
    password: string,
    role: "admin" | "user" = "user",
  ): Promise<{ id: string; name: string; role: string }> {
    return this.accounts.createUser(name, password, role);
  }

  hasAdmin(): Promise<boolean> {
    return this.accounts.hasAdmin();
  }

  listUsers(role?: "admin" | "user"): Promise<Row[]> {
    return this.accounts.listUsers(role);
  }

  checkPassword(
    name: string,
    password: string,
    role: "admin" | "user" = "user",
  ): Promise<{ id: string; kind: "admin" | "user" } | null> {
    return this.accounts.checkPassword(name, password, role);
  }

  userActive(id: string): Promise<boolean> {
    return this.accounts.userActive(id);
  }

  revokeUser(id: string, role: "admin" | "user" = "user", actorId?: string): Promise<boolean> {
    return this.accounts.revokeUser(id, role, actorId);
  }

  resetPassword(id: string, password: string, role: "admin" | "user" = "user"): Promise<boolean> {
    return this.accounts.resetPassword(id, password, role);
  }

  createSession(
    userId: string,
    deviceId: string | null = null,
  ): Promise<{ session: string; expiresAt: number }> {
    return this.sessions.createSession(userId, deviceId);
  }

  authSettings(): Promise<AuthSettings> {
    return this.sessions.authSettings();
  }

  setAuthSettings(value: AuthSettings): Promise<AuthSettings> {
    return this.sessions.setAuthSettings(value);
  }

  touchSession(
    sessionHash: string,
  ): Promise<{ expiresAt: number; idleTimeoutMinutes: number } | null> {
    return this.sessions.touchSession(sessionHash);
  }

  sessionPrincipal(session: string, deviceId: string | null = null): Promise<Principal | null> {
    return this.sessions.sessionPrincipal(session, deviceId);
  }

  sessionForHash(sessionHash: string, deviceId: string | null = null): Promise<Principal | null> {
    return this.sessions.sessionForHash(sessionHash, deviceId);
  }

  logout(sessionHash: string): Promise<void> {
    return this.sessions.logout(sessionHash);
  }

  ticket(principal: Principal): Promise<{ ticket: string; expiresAt: number }> {
    return this.sessions.ticket(principal);
  }

  consumeTicket(ticket: string): Promise<Principal | null> {
    return this.sessions.consumeTicket(ticket);
  }

  registerAgent(
    ownerId: string,
    installationId: string,
    name: string,
    platform: string,
  ): Promise<string> {
    return this.devices.registerAgent(ownerId, installationId, name, platform);
  }

  authorizeDevice(id: string, session: string): Promise<boolean> {
    return this.devices.authorizeDevice(id, session);
  }

  ownsDevice(id: string, principal: Principal): Promise<boolean> {
    return this.devices.ownsDevice(id, principal);
  }

  listDevices(principal: Principal): Promise<Row[]> {
    return this.devices.listDevices(principal);
  }

  revoke(id: string): Promise<boolean> {
    return this.devices.revoke(id);
  }

  touch(id: string): Promise<void> {
    return this.devices.touch(id);
  }

  catalog(id: string): Promise<DeviceCatalog | null> {
    return this.devices.catalog(id);
  }

  saveCatalog(catalog: DeviceCatalog): Promise<void> {
    return this.devices.saveCatalog(catalog);
  }

  command(id: string, commandId: string): Promise<Row | null> {
    return this.commands.command(id, commandId);
  }

  addCommand(command: RemoteCommand): Promise<void> {
    return this.commands.addCommand(command);
  }

  finishCommand(result: CommandResult): Promise<boolean> {
    return this.commands.finishCommand(result);
  }

  expiredCommandDevices(): Promise<string[]> {
    return this.commands.expiredCommandDevices();
  }

  expireCommands(deviceId?: string): Promise<CommandResult[]> {
    return this.commands.expireCommands(deviceId);
  }

  image(
    deviceId: string,
    threadId: string,
    id: string,
    uploadedOnly = false,
  ): Promise<ImagePayload | null> {
    return this.images.image(deviceId, threadId, id, uploadedOnly);
  }

  saveImage(
    deviceId: string,
    threadId: string,
    id: string,
    image: ImagePayload,
    uploaded: boolean,
  ): Promise<void> {
    return this.images.saveImage(deviceId, threadId, id, image, uploaded);
  }

  retainImages(deviceId: string, threadId: string, ids: string[]): Promise<void> {
    return this.images.retainImages(deviceId, threadId, ids);
  }

  snapshot(id: string): Promise<DeviceSnapshot | null> {
    return this.sync.snapshot(id);
  }

  saveSnapshot(snapshot: DeviceSnapshot): Promise<void> {
    return this.sync.saveSnapshot(snapshot);
  }

  async saveEvent(event: RemoteEvent): Promise<void> {
    const startedAt = performance.now();
    let failed = false;
    try {
      await this.sync.saveEvent(event);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.metrics.observeEvent(performance.now() - startedAt, failed);
    }
  }

  replay(id: string, epoch: string, seq: number): Promise<RemoteEvent[] | null> {
    return this.sync.replay(id, epoch, seq);
  }

  snapshotMetadata(id: string): Promise<SnapshotMetadata | null> {
    return this.sync.snapshotMetadata(id);
  }

  async cleanup(options: CleanupOptions = {}): Promise<CleanupSummary> {
    const startedAt = performance.now();
    let deleted = 0;
    let failed = false;
    let summary: CleanupSummary | undefined;
    try {
      const result = await cleanupStorage(this.database.sql, this.weixin, {
        ...options,
        onBatch: (rows) => {
          deleted += rows;
          options.onBatch?.(rows);
        },
      });
      summary = result;
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.metrics.observeCleanup(performance.now() - startedAt, deleted, failed, summary);
    }
  }
}
