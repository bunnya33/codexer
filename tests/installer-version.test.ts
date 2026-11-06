import { expect, it } from 'vitest';
import { installerVersionFromFilename } from '../apps/admin/src/installer-version';

it.each([
  ['Codexer-Control-0.1.9.apk', '0.1.9'],
  ['Codexer Agent Setup 0.2.24.exe', '0.2.24'],
  ['Codexer-Control-v0.2.12-arm64.dmg', '0.2.12'],
  ['连接器_v1.2.3_便携版.EXE', '1.2.3'],
  ['v1.2.3.zip', '1.2.3'],
  ['codexer-server-0.3.38-linux-amd64.tar.gz', '0.3.38'],
])('identifies a stable version in %s', (name, version) => {
  expect(installerVersionFromFilename(name)).toBe(version);
});

it.each(['app-release.apk', 'Codexer-64.exe', 'Codexer-1.2.exe', '1.2.3.4.exe', 'app-1.2.3-to-1.2.4.apk', 'app-1.2.3-beta.apk', 'app-1.2.3-rc.1.apk', 'app-1.2.3+123.apk'])('leaves %s for manual entry', name => {
  expect(installerVersionFromFilename(name)).toBeUndefined();
});
