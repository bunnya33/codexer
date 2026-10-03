export const RELEASE_REPOSITORY = 'bunnya33/codexer';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
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
export function downloadURL(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname)) throw new Error('invalid-download-url');
  if (u.hostname === 'github.com' && !u.pathname.startsWith(`/${RELEASE_REPOSITORY}/releases/download/`)) throw new Error('invalid-download-url');
  return u.href;
}
export function parseRelease(value: unknown): ReleaseInfo {
  const r = value as {tag_name?: string; draft?: boolean; prerelease?: boolean; html_url?: string; body?: string; published_at?: string; assets?: {name: string; browser_download_url: string}[]};
  if (!r || typeof r.tag_name !== 'string' || !STABLE_TAG.test(r.tag_name) || r.draft || r.prerelease) throw new Error('invalid-release');
  const version = r.tag_name.slice(1), name = `codexer-server-${version}.tar.gz`;
  const asset = r.assets?.find(a => a.name === name), checksum = r.assets?.find(a => a.name === name + '.sha256');
  if (!asset || !checksum) throw new Error('release-assets-missing');
  const url = `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${r.tag_name}`;
  if (r.html_url !== url) throw new Error('invalid-release-url');
  return {tag: r.tag_name, version, url, notes: typeof r.body === 'string' ? r.body.slice(0, 16000) : '', publishedAt: typeof r.published_at === 'string' ? r.published_at : '', asset: downloadURL(asset.browser_download_url), checksum: downloadURL(checksum.browser_download_url)};
}
export async function latestRelease(fetcher: typeof fetch = fetch): Promise<ReleaseInfo | null> {
  const response = await fetcher(RELEASE_API, {headers: {'accept': 'application/vnd.github+json', 'user-agent': 'Codexer-server-updater'}, signal: AbortSignal.timeout(15000), redirect: 'error'});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'github-rate-limited' : 'release-check-failed');
  // GitHub metadata is bounded independently of artifact downloads.
  const text = await response.text(); if (text.length > 1024 * 1024) throw new Error('release-response-too-large');
  return parseRelease(JSON.parse(text));
}
export async function stableTags(fetcher: typeof fetch = fetch): Promise<GitTag[]> {
  const response = await fetcher(`https://api.github.com/repos/${RELEASE_REPOSITORY}/tags?per_page=100`, {headers: {accept: 'application/vnd.github+json', 'user-agent': 'Codexer-server-updater'}, signal: AbortSignal.timeout(15000), redirect: 'error'});
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'github-rate-limited' : 'tag-check-failed');
  const text = await response.text(); if (text.length > 1024 * 1024) throw new Error('tag-response-too-large');
  const values: unknown = JSON.parse(text); if (!Array.isArray(values) || values.length > 100) throw new Error('invalid-tags');
  const result: GitTag[] = [];
  for (const value of values) {
    if (!value || typeof value.name !== 'string' || !STABLE_TAG.test(value.name)) continue;
    if (!/^[a-f0-9]{40}$/.test(value.commit?.sha ?? '')) throw new Error('invalid-tags');
    result.push({tag: value.name, version: value.name.slice(1), commit: value.commit.sha});
  }
  return result.sort((a,b) => newerVersion(a.version,b.version) ? -1 : newerVersion(b.version,a.version) ? 1 : 0);
}
