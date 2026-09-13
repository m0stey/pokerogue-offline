// Generates the tray icon and the installer/app icon as plain PNGs, with no dependencies.
// Shape: a flat poke-ball (red top, white bottom, dark band and outline, white centre dot).
// Run: node scripts/make-icons.mjs   (output is committed, so this only needs re-running on a redesign)
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const RED = [214, 48, 49, 255];
const WHITE = [252, 252, 252, 255];
const DARK = [34, 34, 38, 255];
const CLEAR = [0, 0, 0, 0];

function ball(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - Math.max(1, size / 32); // leave a hair of padding
  const ring = Math.max(1, size / 16); // outline + band thickness
  const dot = size / 7;
  const put = (x, y, rgba) => {
    const o = (y * size + x) * 4;
    px[o] = rgba[0];
    px[o + 1] = rgba[1];
    px[o + 2] = rgba[2];
    px[o + 3] = rgba[3];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      let colour = CLEAR;
      if (d <= r) {
        colour = y < c ? RED : WHITE;
        if (d > r - ring) colour = DARK; // outline
        else if (Math.abs(y - c) < ring / 1.2) colour = DARK; // middle band
        if (d <= dot + ring / 1.5) colour = DARK; // centre button rim
        if (d <= dot) colour = WHITE; // centre button
      }
      put(x, y, colour);
    }
  }
  return px;
}

function png(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const out = [
  [resolve(here, "../src/ui/assets/tray.png"), 32],
  [resolve(here, "../build/icon.png"), 256],
];
for (const [file, size] of out) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png(size, ball(size)));
  console.log("wrote", file, size + "x" + size);
}
