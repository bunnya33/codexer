import { nativeImage } from "electron";
import type { NativeImage } from "electron";
export function trayUpdateIcon(icon: NativeImage, available: boolean, mac = false): NativeImage {
  const size = 32,
    image = icon.resize({ width: size, height: size });
  if (!available) return mac ? image.resize({ width: 18, height: 18 }) : image;
  const bytes = image.toBitmap();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - 25, y - 7);
      if (distance > 6) continue;
      const offset = (y * size + x) * 4,
        red = distance <= 4.5;
      bytes[offset] = red ? 58 : 255;
      bytes[offset + 1] = red ? 55 : 255;
      bytes[offset + 2] = red ? 235 : 255;
      bytes[offset + 3] = 255;
    }
  return nativeImage.createFromBitmap(bytes, {
    width: size,
    height: size,
    scaleFactor: mac ? 2 : 1,
  });
}
