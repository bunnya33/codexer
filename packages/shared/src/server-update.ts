export const RELEASE_REPOSITORY = 'bunnya33/codexer';
export const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
export const UPDATE_PROTOCOL = 2;
export type UpdateMethod = 'release' | 'git';
export type UpdateAction = 'update' | 'build' | 'restart';
export type UpdateJob = {id: string; tag: string; method?: UpdateMethod; action?: UpdateAction; commit?: string; phase: 'queued' | 'downloading' | 'verifying' | 'installing' | 'fetching' | 'fetched' | 'building' | 'built' | 'restarting' | 'succeeded' | 'failed' | 'rolled-back'; updatedAt: number; code?: string};
export type GitTag = {tag: string; version: string; commit: string};
export type UpdateSettings = {method: UpdateMethod; autoInstall: boolean};
export function updateRunning(job: UpdateJob | null | undefined): boolean {
  return Boolean(job && !['fetched','built','succeeded','failed','rolled-back'].includes(job.phase));
}
export function nextGitAction(job: UpdateJob | null | undefined, tag: string): UpdateAction {
  if (job?.method !== 'git' || job.tag !== tag) return 'update';
  if (job.phase === 'fetched' || job.phase === 'failed' && job.action === 'build') return 'build';
  if (job.phase === 'built' || job.phase === 'failed' && job.action === 'restart') return 'restart';
  return 'update';
}
export function nextReleaseAction(job: UpdateJob | null | undefined): 'update' | 'restart' {
  return job && job.method !== 'git' && (job.phase === 'built' || job.phase === 'failed' && job.action === 'restart') ? 'restart' : 'update';
}
export type ReleaseInfo = {tag: string; version: string; url: string; notes: string; publishedAt: string; asset: string; checksum: string};
export type VersionInfo = {currentVersion: string; latestVersion: string | null; hasUpdate: boolean; checkedAt: number | null; warning: string | null; release: ReleaseInfo | null; supported: boolean; gitSupported: boolean; method: UpdateMethod; tags: GitTag[]; autoInstall: boolean; job: UpdateJob | null};
export function newerVersion(a: string, b: string): boolean {
  const parse = (s: string) => { const m = STABLE_TAG.exec('v' + s.replace(/^v/, '')); if (!m) throw new Error('invalid-version'); return m.slice(1).map(Number); };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i]! > right[i]!; }
  return false;
}
