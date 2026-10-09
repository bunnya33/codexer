import { mkdir, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";

const directory = "apps/control-desktop/assets";
await mkdir(directory, { recursive: true });

function roundedRect(x, y, left, top, width, height, radius) {
  const dx = Math.abs(x - left - width / 2) - width / 2 + radius;
  const dy = Math.abs(y - top - height / 2) - height / 2 + radius;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function pixel(x, y) {
  if (roundedRect(x, y, 12, 12, 488, 488, 104) > 0) return [0, 0, 0, 0];
  const fraction = Math.max(0, Math.min(1, (y - 12) / 488));
  let color = [105 - 38 * fraction, 87 - 31 * fraction, 212 - 47 * fraction, 255];
  if (
    Math.abs(roundedRect(x, y, 100, 128, 280, 216, 24)) < 10 ||
    segment(x, y, 228, 350, 228, 394) < 10 ||
    segment(x, y, 180, 396, 280, 396) < 10
  )
    color = [255, 255, 255, 255];
  const inTail =
    y >= 346 && y <= 390 && x >= 282 - ((y - 346) * 12) / 44 && x <= 270 + ((390 - y) * 64) / 34;
  if (roundedRect(x, y, 240, 224, 180, 138, 34) < 0 || inTail) color = [112, 224, 208, 255];
  if (segment(x, y, 282, 271, 378, 271) < 8 || segment(x, y, 282, 308, 344, 308) < 8)
    color = [67, 56, 165, 255];
  return color;
}

function render(size) {
  const image = new PNG({ width: size, height: size });
  const samples = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const color = pixel(
            ((x + (sx + 0.5) / samples) * 512) / size,
            ((y + (sy + 0.5) / samples) * 512) / size,
          );
          for (let channel = 0; channel < 3; channel++)
            sum[channel] += (color[channel] * color[3]) / 255;
          sum[3] += color[3];
        }
      const index = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        image.data[index + channel] = sum[3] ? Math.round((sum[channel] * 255) / sum[3]) : 0;
      image.data[index + 3] = Math.round(sum[3] / (samples * samples));
    }
  return PNG.sync.write(image);
}

await writeFile(directory + "/icon.png", render(512));
// ICO includes each Windows display size, avoiding a blurry scaled taskbar/shortcut icon.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(render);
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (let index = 0; index < images.length; index++) {
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await writeFile(directory + "/icon.ico", Buffer.concat([header, ...images]));
