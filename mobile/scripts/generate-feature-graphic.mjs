// Generate the Google Play feature graphic (1024x500, opaque) for Finlynq.
// Matches the brand palette in colors.ts / globals.css and the app icon.
// Run: node scripts/generate-feature-graphic.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "store");
mkdirSync(OUT_DIR, { recursive: true });

const W = 1024;
const H = 500;
const AMBER = "#f5a623";
const INK = "#0b0d10";
const FG = "#e8eaed";
const MUTED = "#9aa3ad";

// Icon block geometry (amber rounded square with an "F", mirrors the app icon).
const ICON = 168;
const ICON_X = 104;
const ICON_Y = (H - ICON) / 2;

const svg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b0d10"/>
      <stop offset="1" stop-color="#12161b"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- app mark -->
  <rect x="${ICON_X}" y="${ICON_Y}" width="${ICON}" height="${ICON}" rx="${Math.round(ICON * 0.22)}" fill="${AMBER}"/>
  <text x="${ICON_X + ICON / 2}" y="${ICON_Y + ICON / 2}" dy="0.04em" text-anchor="middle" dominant-baseline="central"
        font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(ICON * 0.62)}" font-weight="800" fill="${INK}">F</text>

  <!-- wordmark + tagline -->
  <text x="320" y="222" font-family="Arial, Helvetica, sans-serif" font-size="96" font-weight="800" fill="${FG}">Finlynq</text>
  <rect x="324" y="250" width="300" height="6" rx="3" fill="${AMBER}"/>
  <text x="322" y="312" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="600" fill="${MUTED}">Track your money here, analyze it anywhere.</text>
  <text x="322" y="358" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="500" fill="${MUTED}">Private finance · budgets · investments · AI via MCP</text>
</svg>`;

const out = join(OUT_DIR, "feature-graphic.png");
await sharp(Buffer.from(svg))
  .flatten({ background: INK }) // Play requires an opaque feature graphic (no alpha)
  .png()
  .toFile(out);

console.log("Wrote", out, "(1024x500)");
