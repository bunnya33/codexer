import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  latestRelease,
  newerVersion,
  nextGitAction,
  nextReleaseAction,
  stableTags,
  UPDATE_PROTOCOL,
  updateRunning,
} from "../../../../packages/shared/src/server-update.js";
import type {
  GitTag,
  ReleaseInfo,
  UpdateAction,
  UpdateJob,
  UpdateSettings,
  VersionInfo,
} from "../../../../packages/shared/src/server-update.js";

export class ServerUpdates {
  private release: ReleaseInfo | null = null;
  private tags: GitTag[] = [];
  private checkedMethod: UpdateSettings["method"] | null = null;
  private changingSettings = false;
  private checkedAt: number | null = null;
  private warning: string | null = null;
  private checking: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;

  constructor(
    readonly version: string,
    private readonly directory: string,
    private readonly statusPath = "/var/lib/codexer-updater/status.json",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async read<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private async status() {
    return this.read<{
      enabled: boolean;
      protocol?: number;
      gitSupported?: boolean;
      job: UpdateJob | null;
    }>(this.statusPath);
  }

  async info(force = false): Promise<VersionInfo> {
    const settings = await this.read<Partial<UpdateSettings>>(
      join(this.directory, "settings.json"),
    );
    const method = settings?.method === "git" ? "git" : "release";
    if (
      force ||
      this.checkedMethod !== method ||
      !this.checkedAt ||
      Date.now() - this.checkedAt > 20 * 60000
    ) {
      if (!this.checking)
        this.checking = (async () => {
          try {
            if (method === "git") {
              this.tags = await stableTags(this.fetcher);
              this.warning = this.tags.length ? null : "no-stable-tags";
            } else {
              this.release = await latestRelease(this.fetcher);
              this.warning = this.release ? null : "no-published-release";
            }
          } catch (error) {
            this.warning = error instanceof Error ? error.message : "release-check-failed";
          }
          this.checkedAt = Date.now();
          this.checkedMethod = method;
        })().finally(() => {
          this.checking = null;
        });
      await this.checking;
    }
    const status = await this.status();
    const pending = await this.read<UpdateJob>(join(this.directory, "request.json"));
    const job =
      pending &&
      (pending.id !== status?.job?.id ||
        pending.action !== status?.job?.action ||
        pending.updatedAt > status.job.updatedAt)
        ? pending
        : (status?.job ?? null);
    const latestVersion =
      method === "git" ? (this.tags[0]?.version ?? null) : (this.release?.version ?? null);
    return {
      currentVersion: this.version,
      latestVersion,
      hasUpdate: Boolean(latestVersion && newerVersion(latestVersion, this.version)),
      checkedAt: this.checkedAt,
      warning: this.warning,
      release: method === "release" ? this.release : null,
      supported: status?.enabled === true && status.protocol === UPDATE_PROTOCOL,
      gitSupported: status?.protocol === UPDATE_PROTOCOL && status.gitSupported === true,
      method,
      tags: method === "git" ? this.tags : [],
      autoInstall: method === "release" && settings?.autoInstall === true,
      job,
    };
  }

  async setAutoInstall(autoInstall: boolean) {
    return this.setSettings({ autoInstall });
  }

  async setSettings(change: Partial<UpdateSettings>) {
    if (this.changingSettings) throw new Error("update-in-progress");
    this.changingSettings = true;
    try {
      const info = await this.info();
      if (!info.supported) throw new Error("updater-not-installed");
      if (updateRunning(info.job)) throw new Error("update-in-progress");
      const method = change.method ?? info.method;
      if (method === "git" && !info.gitSupported) throw new Error("git-updater-not-installed");
      if (method === "git" && change.autoInstall) throw new Error("git-requires-manual-steps");
      const settings: UpdateSettings = {
        method,
        autoInstall: method === "release" && (change.autoInstall ?? info.autoInstall),
      };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `settings-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.directory, "settings.json"));
      return settings;
    } finally {
      this.changingSettings = false;
    }
  }

  async request(tag: string, action: UpdateAction = "update", jobId?: string): Promise<UpdateJob> {
    if (this.changingSettings) throw new Error("update-in-progress");
    this.changingSettings = true;
    try {
      const info = await this.info(action === "update");
      if (!info.supported) throw new Error("updater-not-installed");
      if (updateRunning(info.job)) throw new Error("update-in-progress");
      if (info.method === "release") {
        if (action === "restart") {
          if (
            !info.job ||
            info.job.tag !== tag ||
            jobId !== info.job.id ||
            nextReleaseAction(info.job) !== "restart"
          )
            throw new Error("update-step-not-ready");
        } else if (
          action !== "update" ||
          info.warning ||
          !info.hasUpdate ||
          info.release?.tag !== tag
        )
          throw new Error("update-not-current");
      } else {
        if (!info.gitSupported) throw new Error("git-updater-not-installed");
        if (action === "update") {
          if (
            info.warning ||
            !info.tags.some((item) => item.tag === tag && newerVersion(item.version, this.version))
          )
            throw new Error("tag-not-available");
        } else if (!info.job || jobId !== info.job.id || nextGitAction(info.job, tag) !== action)
          throw new Error("update-step-not-ready");
      }
      const job: UpdateJob = {
        id: action === "update" ? randomUUID() : jobId!,
        tag,
        method: info.method,
        action,
        ...(action !== "update" && info.job?.commit ? { commit: info.job.commit } : {}),
        phase: "queued",
        updatedAt: Date.now(),
      };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        await writeFile(join(this.directory, "request.json"), JSON.stringify(job), {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("update-in-progress");
        throw error;
      }
      return job;
    } finally {
      this.changingSettings = false;
    }
  }

  start() {
    const check = async () => {
      try {
        const info = await this.info(true);
        // Failed preparation requires explicit intervention; activation is always manual.
        if (
          info.method === "release" &&
          info.autoInstall &&
          info.supported &&
          info.hasUpdate &&
          !info.warning &&
          info.release &&
          (!info.job || info.job.phase === "succeeded")
        )
          await this.request(info.release.tag);
      } catch {
        /* Version checks must not stop the Relay. */
      }
    };
    this.timer = setInterval(() => void check(), 6 * 3600000);
    this.timer.unref();
    void check();
  }

  close() {
    clearInterval(this.timer);
  }
}
