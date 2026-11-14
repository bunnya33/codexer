import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const assets = fileURLToPath(new URL('../apps/mobile/assets/', import.meta.url));
const clamp = value => Math.max(0, Math.min(1, value));

// Bilinear interpolation in premultiplied alpha keeps transparent edges clean.
function resize(source, size, inset = 0) {
  const output = new PNG({ width: size, height: size });
  const scale = (1 - inset * 2) * size / source.width;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = (x + 0.5 - size * inset) / scale - 0.5;
    const sy = (y + 0.5 - size * inset) / scale - 0.5;
    if (sx < -0.5 || sy < -0.5 || sx > source.width - 0.5 || sy > source.height - 0.5) continue;
    const px = Math.max(0, Math.min(source.width - 1, sx));
    const py = Math.max(0, Math.min(source.height - 1, sy));
    const left = Math.floor(px), top = Math.floor(py), dx = px - left, dy = py - top;
    const sum = [0, 0, 0, 0];
    for (const [ox, oy, weight] of [[0, 0, (1 - dx) * (1 - dy)], [1, 0, dx * (1 - dy)], [0, 1, (1 - dx) * dy], [1, 1, dx * dy]]) {
      const index = (Math.min(top + oy, source.height - 1) * source.width + Math.min(left + ox, source.width - 1)) * 4;
      const alpha = source.data[index + 3] / 255 * weight;
      for (let channel = 0; channel < 3; channel++) sum[channel] += source.data[index + channel] * alpha;
      sum[3] += alpha;
    }
    const index = (y * size + x) * 4;
    for (let channel = 0; channel < 3; channel++) output.data[index + channel] = sum[3] ? Math.round(sum[channel] / sum[3]) : 0;
    output.data[index + 3] = Math.round(sum[3] * 255);
  }
  return output;
}

export function generateAndroidIcons() {
  const source = PNG.sync.read(readFileSync(join(assets, 'android-icon-source.png')));
  if (source.width !== source.height) throw new Error('Android icon source must be square');
  const foreground = new PNG({ width: source.width, height: source.height });
  const monochrome = new PNG({ width: source.width, height: source.height });
  const background = new PNG({ width: 1024, height: 1024 });
  // Keep the supplied black-and-white frog artwork intact. White stays in the
  // foreground so the subject remains legible against the white adaptive layer.
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const index = (y * source.width + x) * 4;
      foreground.data.set(source.data.subarray(index, index + 4), index);
      for (let channel = 0; channel < 3; channel++) {
        monochrome.data[index + channel] = 255;
      }
      const luminance = (source.data[index] + source.data[index + 1] + source.data[index + 2]) / (3 * 255);
      // A transparent mask of the ink supports Android's themed launcher icons.
      monochrome.data[index + 3] = Math.round(clamp((1 - luminance - 0.08) / 0.92) * source.data[index + 3]);
    }
  }
  background.data.fill(255);
  const save = (name, png) => writeFileSync(join(assets, name), PNG.sync.write(png));
  save('android-icon.png', resize(source, 1024));
  save('android-icon-background.png', background);
  // Android displays the central 72dp of a 108dp adaptive layer at rest.
  save('android-icon-foreground.png', resize(foreground, 1024, 1 / 6));
  save('android-icon-monochrome.png', resize(monochrome, 1024, 1 / 6));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateAndroidIcons();
