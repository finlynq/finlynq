/**
 * How to frame an account logo, read from its own pixels (GH #436).
 *
 * Every logo is a square PNG (toLogoPng letterboxes non-square images onto a
 * transparent square). Always drawing it on a white tile with padding framed
 * full-bleed logos (Amex, Chase) in a white box and hid light marks.
 *
 *   bleed  the image fills its square (all four corners opaque): no tile, no
 *          padding, edge to edge.
 *   fill   an opaque rectangle letterboxed onto the square (it spans the full
 *          width or height): a tile in the rectangle's own edge colour, so the
 *          bands blend in.
 *   dark   a light mark on transparency (would vanish on white): dark tile.
 *   light  any other mark on transparency: white tile (keeps a dark mark
 *          readable in dark mode).
 *
 * Pure: takes RGBA pixel data, so it can be tested without a canvas.
 */
export type LogoTile =
  | { kind: "bleed" }
  | { kind: "fill"; color: string }
  | { kind: "dark" }
  | { kind: "light" };

const OPAQUE = 250;
const VISIBLE = 128;

export function chooseLogoTile(data: ArrayLike<number>, width: number, height: number): LogoTile {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return { kind: "light" };
  const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3];
  const rgbAt = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const last = { x: width - 1, y: height - 1 };
  const cornersOpaque =
    alphaAt(0, 0) >= OPAQUE &&
    alphaAt(last.x, 0) >= OPAQUE &&
    alphaAt(0, last.y) >= OPAQUE &&
    alphaAt(last.x, last.y) >= OPAQUE;
  if (cornersOpaque) return { kind: "bleed" };

  // Letterboxed opaque rectangle: the middle row (wide image) or middle column
  // (tall image) is opaque from edge to edge.
  const midY = Math.floor(height / 2);
  const midX = Math.floor(width / 2);
  const rowOpaque = alphaAt(0, midY) >= OPAQUE && alphaAt(last.x, midY) >= OPAQUE;
  const colOpaque = alphaAt(midX, 0) >= OPAQUE && alphaAt(midX, last.y) >= OPAQUE;
  if (rowOpaque) return { kind: "fill", color: hex(rgbAt(0, midY)) };
  if (colOpaque) return { kind: "fill", color: hex(rgbAt(midX, 0)) };

  // A mark on transparency: how light is what's drawn?
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alphaAt(x, y) < VISIBLE) continue;
      const [r, g, b] = rgbAt(x, y);
      sum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      n++;
    }
  }
  if (n === 0) return { kind: "light" };
  return sum / n > 0.8 ? { kind: "dark" } : { kind: "light" };
}

function hex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
