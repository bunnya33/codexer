import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { latestRelease, newerVersion } from '../../../packages/shared/src/server-update.js';
import type { ReleaseInfo, UpdateJob, VersionInfo } from '../../../packages/shared/src/server-update.js';

export class ServerUpdates {
  private release: ReleaseInfo | null = null;
  private checkedAt: number | null = null;
  private warning: string | null = null;
  private checking: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;
  constructor(readonly version: string, private readonly directory: string, private readonly statusPath = '/var/lib/codexer-updater/status.json', private readonly fetcher: typeof fetch = fetch) {}
  private async read<T>(path: string): Promise<T | null> { try {return JSON.parse(await readFile(path, 'utf8')) as T;} catch {return null;} }
  private async status() { return this.read<{enabled: boolean; job: UpdateJob | null}>(this.statusPath); }
  async info(force = false): Promise<VersionInfo> {
    if (force || !this.checkedAt || Date.now() - this.checkedAt > 20 * 60000) {
      if (!this.checking) this.checking = (async () => {
        try { this.release = await latestRelease(this.fetcher); this.warning = this.release ? null : 'no-published-release'; }
        catch (error) {this.warning = error instanceof Error ? error.message : 'release-check-failed';}
        this.checkedAt = Date.now();
      })().finally(() => {this.checking = null;});
      await this.checking;
    }
    const status = await this.status(), settings = await this.read<{autoInstall?: boolean}>(join(this.directory, 'settings.json'));
    const pending = await this.read<UpdateJob>(join(this.directory, 'request.json'));
    const job = pending && pending.id !== status?.job?.id ? pending : status?.job ?? null;
    return {currentVersion: this.version, latestVersion: this.release?.version ?? null, hasUpdate: Boolean(this.release && newerVersion(this.release.version, this.version)), checkedAt: this.checkedAt, warning: this.warning, release: this.release, supported: status?.enabled === true, autoInstall: settings?.autoInstall === true, job};
  }
  async setAutoInstall(autoInstall: boolean) {
    if (!(await this.status())?.enabled) throw new Error('updater-not-installed');
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const temporary = join(this.directory, `settings-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({autoInstall}), {mode: 0o600, flag: 'wx'});
    await rename(temporary, join(this.directory, 'settings.json'));
    return {autoInstall};
  }
  async request(tag: string): Promise<UpdateJob> {
    const info = await this.info(true);
    if (!info.supported) throw new Error('updater-not-installed');
    if (info.warning || !info.hasUpdate || info.release?.tag !== tag) throw new Error('update-not-current');
    if (info.job && !['succeeded','failed','rolled-back'].includes(info.job.phase)) throw new Error('update-in-progress');
    const job: UpdateJob = {id: randomUUID(), tag, phase: 'queued', updatedAt: Date.now()};
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    try {await writeFile(join(this.directory, 'request.json'), JSON.stringify(job), {mode: 0o600, flag: 'wx'});}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('update-in-progress'); throw error;}
    return job;
  }
  start() {
    const check = async () => {
      try {
        const info = await this.info(true);
        // A failed automatic installation requires explicit intervention, avoiding a retry loop.
        if (info.autoInstall && info.supported && info.hasUpdate && !info.warning && info.release && (!info.job || info.job.phase === 'succeeded')) await this.request(info.release.tag);
      } catch { /* Version checks must not stop the Relay. */ }
    };
    this.timer = setInterval(() => void check(), 6 * 3600000); this.timer.unref(); void check();
  }
  close() {clearInterval(this.timer);}
}
