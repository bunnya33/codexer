/** Expo's iOS picker can return JPEG base64 with the original PNG/HEIC MIME. */
export function imageBase64Mime(base64: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  let header: string;
  try { header = atob(base64.replace(/\s/g, '').slice(0, 32)); }
  catch { return null; }
  if (header.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (header.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}
