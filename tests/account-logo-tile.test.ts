/**
 * GH #436: how an account logo is framed comes from its own pixels.
 */
import { describe, it, expect } from "vitest";
import { chooseLogoTile } from "@/lib/accounts/logo-tile";

type RGBA = [number, number, number, number];
const CLEAR: RGBA = [0, 0, 0, 0];

/** Build a w x h image; `px(x, y)` gives each pixel. */
function image(w: number, h: number, px: (x: number, y: number) => RGBA): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(px(x, y), (y * w + x) * 4);
  return d;
}

describe("chooseLogoTile", () => {
  it("a logo that fills its square bleeds edge to edge", () => {
    const amex = image(8, 8, () => [0, 111, 207, 255]);
    expect(chooseLogoTile(amex, 8, 8)).toEqual({ kind: "bleed" });
  });

  it("a wide opaque logo letterboxed onto the square sits on its own edge colour", () => {
    // Rows 2..5 opaque white with a blue mark in the middle, rows 0-1 and 6-7 clear.
    const wide = image(8, 8, (x, y) => (y < 2 || y > 5 ? CLEAR : x === 4 ? [0, 0, 200, 255] : [255, 255, 255, 255]));
    expect(chooseLogoTile(wide, 8, 8)).toEqual({ kind: "fill", color: "#ffffff" });
  });

  it("a tall letterboxed logo uses its top edge colour", () => {
    const tall = image(8, 8, (x) => (x < 2 || x > 5 ? CLEAR : [20, 30, 40, 255]));
    expect(chooseLogoTile(tall, 8, 8)).toEqual({ kind: "fill", color: "#141e28" });
  });

  it("a light mark on transparency gets a dark tile", () => {
    const whiteMark = image(8, 8, (x, y) => (x > 2 && x < 6 && y > 2 && y < 6 ? [250, 250, 250, 255] : CLEAR));
    expect(chooseLogoTile(whiteMark, 8, 8)).toEqual({ kind: "dark" });
  });

  it("a dark or coloured mark on transparency keeps the white tile", () => {
    const darkMark = image(8, 8, (x, y) => (x > 2 && x < 6 && y > 2 && y < 6 ? [10, 40, 90, 255] : CLEAR));
    expect(chooseLogoTile(darkMark, 8, 8)).toEqual({ kind: "light" });
  });

  it("an empty or short image falls back to the white tile", () => {
    expect(chooseLogoTile(image(4, 4, () => CLEAR), 4, 4)).toEqual({ kind: "light" });
    expect(chooseLogoTile(new Uint8ClampedArray(3), 4, 4)).toEqual({ kind: "light" });
  });
});
