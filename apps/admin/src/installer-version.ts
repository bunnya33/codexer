/** Only one unambiguous stable three-part version may fill the upload form. */
export function installerVersionFromFilename(name: string): string | undefined {
  const stem = name.replace(/\.(?:apk|exe|dmg|zip|msi|pkg|appimage|tar\.gz)$/i, '');
  const matches = [...stem.matchAll(/(?<![\da-z.])v?(\d+\.\d+\.\d+)(?![\da-z.]|[-+](?:alpha|beta|rc|pre|dev|\d))/gi)];
  const versions = new Set(matches.map(match => match[1]!));
  return versions.size === 1 ? [...versions][0] : undefined;
}
