export const RELEASE_REPOSITORY = 'bunnya33/codexer';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
export const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
export type UpdateJob = {id: string; tag: string; phase: 'queued' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'succeeded' | 'failed' | 'rolled-back'; updatedAt: number; code?: string};
export type ReleaseInfo = {tag: string; version: string; url: string; notes: string; publishedAt: string; asset: string; checksum: string};
export type VersionInfo = {currentVersion: string; latestVersion: string | null; hasUpdate: boolean; checkedAt: number | null; warning: string | null; release: ReleaseInfo | null; supported: boolean; autoInstall: boolean; job: UpdateJob | null};
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
