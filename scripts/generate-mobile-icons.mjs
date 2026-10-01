import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const target = fileURLToPath(new URL('../apps/mobile/assets/', import.meta.url));
const dark = [25, 36, 38];
const light = [247, 248, 248];
const accent = [39, 184, 145];

function distance(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function blend(data, index, color, alpha) {
  const oldAlpha = data[index + 3] / 255;
  const combined = alpha + oldAlpha * (1 - alpha);
  if (!combined) return;
  for (let channel = 0; channel < 3; channel++) data[index + channel] = Math.round((color[channel] * alpha + data[index + channel] * oldAlpha * (1 - alpha)) / combined);
  data[index + 3] = Math.round(combined * 255);
}

function draw(name, size, background, monochrome = false, symbolScale = 1) {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = (y * size + x) * 4;
    if (background) { png.data[index] = dark[0]; png.data[index + 1] = dark[1]; png.data[index + 2] = dark[2]; png.data[index + 3] = 255; }
    if (symbolScale === 0) continue;
    let prompt = 0, cursor = 0;
    for (const ox of [0.25, 0.75]) for (const oy of [0.25, 0.75]) {
      const px = ((x + ox) / size - 0.5) * 1024 / symbolScale + 512;
      const py = ((y + oy) / size - 0.5) * 1024 / symbolScale + 512;
      if (Math.min(distance(px, py, 276, 333, 450, 512), distance(px, py, 450, 512, 276, 691)) < 35) prompt += 0.25;
      if (distance(px, py, 500, 665, 748, 665) < 35) cursor += 0.25;
    }
    if (prompt) blend(png.data, index, light, prompt);
    if (cursor) blend(png.data, index, monochrome ? light : accent, cursor);
  }
  writeFileSync(join(target, name), PNG.sync.write(png));
}

draw('icon.png', 1024, true);
draw('favicon.png', 48, true);
draw('android-icon-background.png', 512, true, false, 0);
draw('android-icon-foreground.png', 512, false, false, 0.85);
draw('android-icon-monochrome.png', 432, false, true, 0.85);
draw('splash-icon.png', 1024, false, false, 0.8);
