import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const assets = new URL('../apps/mobile/assets/', import.meta.url);
const source = PNG.sync.read(readFileSync(new URL('frogcoder-icon.png', assets)));
if (source.width !== 1024 || source.height !== 1024) throw new Error('Expected the original 1024px frog artwork');
const { width, height, data } = source;
const count = width * height;
const regions = new Int32Array(count).fill(-1);
const queue = new Int32Array(count);
let region = 0;
// Enclosed light regions separate the body, feet, eye highlights and belly.
// Recolor the body and feet only; retain the original ink and belly artwork.
for (let pixel = 0; pixel < count; pixel++) {
  if (regions[pixel] !== -1 || Math.min(...data.subarray(pixel * 4, pixel * 4 + 3)) < 40) continue;
  let first = 0, last = 1;
  queue[0] = pixel;
  regions[pixel] = region;
  while (first < last) {
    const current = queue[first++], x = current % width, y = Math.floor(current / width);
    for (const next of [x > 0 ? current - 1 : -1, x < width - 1 ? current + 1 : -1, y > 0 ? current - width : -1, y < height - 1 ? current + width : -1]) {
      if (next < 0 || regions[next] !== -1 || Math.min(...data.subarray(next * 4, next * 4 + 3)) < 40) continue;
      regions[next] = region;
      queue[last++] = next;
    }
  }
  region++;
}
const outside = regions[0];
const body = new Set([[512, 290], [235, 830], [815, 790]].map(([x, y]) => regions[y * width + x]));
if (body.size !== 3 || body.has(outside) || body.has(-1)) throw new Error('Body regions did not match the supplied artwork');

// These assets render at 42pt. A 256px image covers Retina displays without
// embedding three full launcher-sized pictures. Average premultiplied pixels
// so transparent edges remain smooth on either theme.
function headerSize(source) {
  const output = new PNG({ width: 256, height: 256 });
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const sum = [0, 0, 0, 0];
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
      const index = ((y * 4 + dy) * width + x * 4 + dx) * 4;
      const alpha = source.data[index + 3] / 255;
      for (let channel = 0; channel < 3; channel++) sum[channel] += source.data[index + channel] * alpha;
      sum[3] += alpha;
    }
    const index = (y * 256 + x) * 4;
    for (let channel = 0; channel < 3; channel++) output.data[index + channel] = sum[3] ? Math.round(sum[channel] / sum[3]) : 0;
    output.data[index + 3] = Math.round(sum[3] / 16 * 255);
  }
  return output;
}

for (const [name, color] of Object.entries({ offline: null, idle: [158, 219, 64], running: [255, 218, 0] })) {
  const output = new PNG({ width, height });
  output.data.set(data);
  for (let pixel = 0; pixel < count; pixel++) {
    const offset = pixel * 4;
    const light = (data[offset] + data[offset + 1] + data[offset + 2]) / (3 * 255);
    if (regions[pixel] === outside) {
      // Remove the white canvas while retaining antialiased black outer edges.
      output.data.fill(0, offset, offset + 3);
      output.data[offset + 3] = Math.round(255 * (1 - light));
    } else if (color && body.has(regions[pixel])) {
      const x = pixel % width, y = Math.floor(pixel / width);
      const highlight = Math.max(0, 1 - Math.hypot((x - 350) / 600, (y - 230) / 700)) * 0.08;
      for (let channel = 0; channel < 3; channel++) output.data[offset + channel] = Math.round((color[channel] + (255 - color[channel]) * highlight) * light);
    }
  }
  writeFileSync(new URL(`frogcoder-status-${name}.png`, assets), PNG.sync.write(headerSize(output)));
}
console.log(`Generated three frog status icons in ${fileURLToPath(assets)}`);
