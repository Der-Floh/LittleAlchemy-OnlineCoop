// Draws the extension icon (two overlapping rings on a magenta tile: two
// players combining things) and writes PNGs, with no image dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const SIZES = [16, 32, 48, 128];
const OUT = 'extension/icons';
const SUPER = 5; // supersampling per axis, for anti-aliasing

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

const TOP: RGB = [184, 57, 156];
const BOTTOM: RGB = [134, 36, 116];

function sample(x: number, y: number): RGBA {
  // Coordinates are in 0..1.
  const r = 0.22;
  const inset = 0.02;
  const cx = Math.min(Math.max(x, inset + r), 1 - inset - r);
  const cy = Math.min(Math.max(y, inset + r), 1 - inset - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];

  const t = y;
  let color = TOP.map((c, i) => c + (BOTTOM[i]! - c) * t) as RGB;
  const blend = (alpha: number) => {
    color = color.map((c) => c + (255 - c) * alpha) as RGB;
  };

  const rad = 0.215;
  const stroke = 0.075;
  const a = Math.hypot(x - 0.385, y - 0.5);
  const b = Math.hypot(x - 0.615, y - 0.5);
  if (a < rad && b < rad) blend(0.45);
  if (Math.abs(a - rad) <= stroke / 2 || Math.abs(b - rad) <= stroke / 2) blend(1);
  return [...color, 255];
}

function render(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let as = 0;
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          const [r, g, b, a] = sample((px + (sx + 0.5) / SUPER) / size, (py + (sy + 0.5) / SUPER) / size);
          rs += r * a;
          gs += g * a;
          bs += b * a;
          as += a;
        }
      }
      const i = (py * size + px) * 4;
      const n = SUPER * SUPER;
      pixels[i + 3] = Math.round(as / n);
      if (as > 0) {
        pixels[i] = Math.round(rs / as);
        pixels[i + 1] = Math.round(gs / as);
        pixels[i + 2] = Math.round(bs / as);
      }
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size: number, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  writeFileSync(`${OUT}/icon${size}.png`, png(size, render(size)));
  console.log(`wrote ${OUT}/icon${size}.png`);
}
