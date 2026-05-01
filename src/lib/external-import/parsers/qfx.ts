/**
 * QFX → canonical RawTransaction[] emitter (issue #64).
 *
 * QFX is OFX wrapped with Quicken-specific headers. The actual SGML/XML body
 * is identical to OFX; the only differences are:
 *
 *   1. The `<INTU.BID>` / `<INTU.USERID>` / `<INTU.…>` blocks Quicken
 *      sprinkles in (handled by `stripHeaders` inside `ofx-parser.ts`).
 *   2. The format tag — rows emitted from a `.qfx` upload carry
 *      `source:qfx` for downstream cross-source dedup.
 *
 * This file is a thin wrapper that calls the OFX canonical emitter with
 * `format = "qfx"`. Keeping it as its own module makes the dispatcher cleaner
 * and gives a clear extension point if QFX ever diverges further.
 */

import { parseOfxToCanonical } from "./ofx";
import type { OfxCanonicalResult } from "./ofx";

export function parseQfxToCanonical(raw: string): OfxCanonicalResult {
  return parseOfxToCanonical(raw, "qfx");
}
