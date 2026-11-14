import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ managed: vi.fn(), seed: vi.fn(), open: vi.fn() }));
vi.mock('../apps/mobile/src/downloads-mobile', () => ({ downloadManaged: mocks.managed, downloadSeed: mocks.seed, openDownload: mocks.open }));
const modulePath: string = '../apps/mobile/src/client-update-download';
const { downloadClientUpdate } = await import(modulePath);
const release = { id: '00000000-0000-4000-8000-000000000001', target: 'control-android', name: 'FrogCoder.apk', version: '0.1.21', buildNumber: 24, size: 1024, sha256: 'a'.repeat(64), notes: '', uploadedAt: 1 };
const source = { uri: 'https://relay.test/download', headers: { Authorization: 'Bearer fixture' } };
const item = { id: 'download', name: release.name, state: 'completed' };
beforeEach(() => {
  vi.resetAllMocks(); mocks.seed.mockImplementation((_, value) => value); mocks.managed.mockResolvedValue(item); mocks.open.mockResolvedValue('opened');
});
it('routes updates into the persistent library and retains installer verification phases', async () => {
  const controller = new AbortController(), progress = vi.fn(), phase = vi.fn();
  expect(await downloadClientUpdate(source, release, controller.signal, progress, phase)).toBe('opened');
  expect(mocks.seed).toHaveBeenCalledWith(source, { name: release.name, size: 1024, version: release.sha256, release: { id: release.id, sha256: release.sha256 } });
  expect(mocks.managed).toHaveBeenCalledWith(expect.any(Object), controller.signal, progress);
  expect(mocks.open).toHaveBeenCalledWith(item, { signal: controller.signal, phase });
  expect(phase).toHaveBeenCalledWith('downloading');
});
it('keeps completed files when installation permission is required', async () => {
  mocks.open.mockResolvedValue('permission-required');
  expect(await downloadClientUpdate(source, release, new AbortController().signal, () => {})).toBe('permission-required');
});
it('never opens an installer after cancellation or a failed managed download', async () => {
  const controller = new AbortController(); mocks.managed.mockImplementation(async () => { controller.abort(); return item; });
  await expect(downloadClientUpdate(source, release, controller.signal, () => {})).rejects.toThrow('暂停'); expect(mocks.open).not.toHaveBeenCalled();
  mocks.managed.mockRejectedValue(Error('download-failed'));
  await expect(downloadClientUpdate(source, release, new AbortController().signal, () => {})).rejects.toThrow('download-failed'); expect(mocks.open).not.toHaveBeenCalled();
});
