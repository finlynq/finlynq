// Render the Finlynq SVG into a multi-size .ico (PNG-encoded entries).
// Sizes 16, 32, 48, 64, 128, 256 cover legacy browsers, modern browsers, and
// Google s2/favicons (which fetches sz=64 by default).

import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";

const SVG_PATH = "C:/Users/halaw/Projects/PF/pf-app/public/favicon.svg";
const ICO_PATH = "C:/temp/finlynq-new.ico";
const PREVIEW_64 = "C:/temp/finlynq-new-64.png";

const sizes = [16, 32, 48, 64, 128, 256];
const svg = readFileSync(SVG_PATH);

const pngs = await Promise.all(
  sizes.map((s) =>
    sharp(svg, { density: 384 }).resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
  ),
);

// Save the 64px preview separately so we can inspect it visually
writeFileSync(PREVIEW_64, pngs[3]);

// Build ICO file: 6-byte header + N×16-byte ICONDIRENTRY + concatenated PNG data
const HEADER = 6;
const ENTRY = 16;
const dataStart = HEADER + ENTRY * sizes.length;

const out = Buffer.alloc(dataStart + pngs.reduce((n, p) => n + p.length, 0));
out.writeUInt16LE(0, 0); // reserved
out.writeUInt16LE(1, 2); // type 1 = icon
out.writeUInt16LE(sizes.length, 4);

let offset = dataStart;
for (let i = 0; i < sizes.length; i++) {
  const s = sizes[i];
  const png = pngs[i];
  const e = HEADER + i * ENTRY;
  out.writeUInt8(s === 256 ? 0 : s, e + 0);     // width  (0 means 256)
  out.writeUInt8(s === 256 ? 0 : s, e + 1);     // height (0 means 256)
  out.writeUInt8(0, e + 2);                     // color count
  out.writeUInt8(0, e + 3);                     // reserved
  out.writeUInt16LE(1, e + 4);                  // planes
  out.writeUInt16LE(32, e + 6);                 // bpp
  out.writeUInt32LE(png.length, e + 8);         // image size
  out.writeUInt32LE(offset, e + 12);            // image offset
  png.copy(out, offset);
  offset += png.length;
}

writeFileSync(ICO_PATH, out);
console.log(`wrote ${ICO_PATH} bytes=${out.length} sizes=${sizes.join(",")}`);
