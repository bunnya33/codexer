import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { ClientUpdateChecker } from "../../../packages/client-shared/src/client-updates";
import { clientUpdateAvailable } from "../../../packages/shared/src/client-release";
import type { ClientTarget, ClientUpdateState } from "../../../packages/shared/src/client-release";

export type DesktopUpdateState = ClientUpdateState & {
  available: boolean;
  downloading: boolean;
  progress: number;
  downloaded: boolean;
  version: string;
};
export type UpdateConnection = { url: string; session: string; deviceId?: string };
type DownloadJob = { revision: number; abort: AbortController; task: Promise<void> };

export class DesktopClientUpdates {
  readonly checker = new ClientUpdateChecker();
  private connection: UpdateConnection | undefined;
  private downloaded: { id: string; path: string } | undefined;
  private job: DownloadJob | undefined;
  private progress = 0;
  private error = "";
  private revision = 0;

  constructor(
    readonly target: ClientTarget,
    readonly version: string,
    private directory: string,
    private changed: (state: DesktopUpdateState) => void,
  ) {
    this.checker.subscribe(() => {
      if (this.downloaded?.id !== this.checker.getSnapshot().release?.id)
        this.downloaded = undefined;
      this.publish();
    });
  }
  state(): DesktopUpdateState {
    const view = this.checker.getSnapshot();
    return {
      ...view,
      error: this.error || view.error,
      available: clientUpdateAvailable(view.release, this.version),
      downloading: !!this.job,
      progress: this.progress,
      downloaded: !!this.downloaded && this.downloaded.id === view.release?.id,
      version: this.version,
    };
  }
  private publish() {
    this.changed(this.state());
  }
  configure(connection?: UpdateConnection) {
    const key = connection ? JSON.stringify(connection) : "";
    if (key === (this.connection ? JSON.stringify(this.connection) : "")) return;
    this.revision++;
    this.job?.abort.abort();
    this.job = undefined;
    this.connection = connection;
    this.downloaded = undefined;
    this.error = "";
    this.progress = 0;
    this.checker.configure(key, connection ? this.target : undefined, async (signal) => {
      const response = await fetch(connection!.url + "/v1/client-releases/" + this.target, {
        headers: this.headers(connection!),
        signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error("update-check-failed");
      return response.json();
    });
  }
  private headers(connection: UpdateConnection) {
    return {
      authorization: "Bearer " + connection.session,
      ...(connection.deviceId ? { "x-device-id": connection.deviceId } : {}),
    };
  }
  async check() {
    this.error = "";
    await this.checker.check();
  }
  cancel() {
    this.job?.abort.abort();
  }
  download(): Promise<void> {
    if (this.job) return this.job.task;
    const job: DownloadJob = {
      revision: this.revision,
      abort: new AbortController(),
      task: Promise.resolve(),
    };
    this.job = job;
    job.task = this.performDownload(job).finally(() => {
      if (this.job === job) {
        this.job = undefined;
        this.publish();
      }
    });
    return job.task;
  }
  private async performDownload(job: DownloadJob) {
    const { abort, revision } = job;
    let temporary: string | undefined;
    const timer = setTimeout(() => abort.abort(), 15 * 60 * 1000);
    const active = () => revision === this.revision && !abort.signal.aborted;
    try {
      this.progress = 0;
      await this.check();
      if (!active()) throw new Error("下载已取消");
      const release = this.checker.getSnapshot().release,
        connection = this.connection;
      if (!connection || !release || !this.state().available) throw new Error("没有可下载的新版本");
      const path = join(
        this.directory,
        release.id + (release.target.includes("macos") ? ".dmg" : ".exe"),
      );
      // A unique partial file also isolates an aborted download from a new login.
      temporary = path + "." + randomUUID() + ".part";
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!active()) throw new Error("下载已取消");
      const response = await fetch(
        connection.url + `/v1/client-releases/${this.target}/${release.id}/download`,
        { headers: this.headers(connection), signal: abort.signal, redirect: "error" },
      );
      if (!response.ok || !response.body) throw new Error("下载失败，请重新检查版本后重试");
      const file = await open(temporary, "wx", 0o600),
        hash = createHash("sha256");
      let size = 0,
        last = 0;
      try {
        for await (const chunk of response.body) {
          if (!active()) throw new Error("下载已取消");
          size += chunk.length;
          if (size > release.size) throw new Error("安装包大小不匹配");
          hash.update(chunk);
          await file.writeFile(chunk);
          if (active()) {
            this.progress = size / release.size;
            if (Date.now() - last > 200) {
              this.publish();
              last = Date.now();
            }
          }
        }
      } finally {
        await file.close();
      }
      if (!active()) throw new Error("下载已取消");
      if (size !== release.size || hash.digest("hex") !== release.sha256)
        throw new Error("安装包校验失败，请重新下载");
      if (release.id !== this.checker.getSnapshot().release?.id)
        throw new Error("版本已变更，请重新下载");
      await rename(temporary, path);
      if (!active()) throw new Error("下载已取消");
      this.downloaded = { id: release.id, path };
      this.progress = 1;
    } catch (error) {
      if (revision === this.revision)
        this.error = abort.signal.aborted
          ? "下载已取消"
          : error instanceof Error
            ? error.message
            : "下载失败，请重试";
      throw error;
    } finally {
      clearTimeout(timer);
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
    }
  }
  async verifiedPackage(): Promise<string> {
    const release = this.checker.getSnapshot().release,
      downloaded = this.downloaded,
      revision = this.revision;
    if (!release || !downloaded || release.id !== downloaded.id) throw new Error("请先下载更新");
    try {
      if ((await stat(downloaded.path)).size !== release.size) throw new Error("invalid-size");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(downloaded.path)) hash.update(chunk);
      if (hash.digest("hex") !== release.sha256) throw new Error("invalid-hash");
    } catch {
      if (revision === this.revision) {
        this.downloaded = undefined;
        this.error = "安装包校验失败，请重新下载";
        this.publish();
      }
      throw new Error("安装包校验失败，请重新下载");
    }
    if (revision !== this.revision || release.id !== this.checker.getSnapshot().release?.id)
      throw new Error("连接或版本已变更，请重新下载");
    return downloaded.path;
  }
  dispose() {
    this.configure();
    this.checker.dispose();
  }
}
