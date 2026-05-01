/**
 * File-format sniffer for investment-statement uploads (issue #64).
 *
 * Decides which canonical parser to call given the file's name + first
 * bytes. Extension hints first, then content-sniff to disambiguate `.xml`
 * (which could be IBKR FlexQuery, OFX-XML, or unknown).
 *
 * Discriminated union return so callers `switch` on `format` and the
 * compiler enforces every branch.
 */

export type DetectedFormat =
  | "ofx-sgml"  // SGML form (OFXHEADER:100), bank/CC/investment
  | "ofx-xml"   // OFX wrapped in <?xml … ?>, same payload shapes
  | "qfx"       // Quicken-flavored OFX (SGML or XML form)
  | "ibkr-flex" // <FlexQueryResponse> root
  | "unknown";

export interface DetectResult {
  format: DetectedFormat;
}

/**
 * Detect the format of an uploaded file. Pass the `fileName` (for the
 * extension hint) and the first ~1KB of `text` (the content-sniff).
 *
 * Detection order:
 *   1. `.qfx` extension → "qfx" (regardless of payload — Quicken always
 *       brands with this extension).
 *   2. SGML header `OFXHEADER:` → "ofx-sgml".
 *   3. `<FlexQueryResponse>` substring → "ibkr-flex" (IBKR's distinctive
 *       root element; appears in the first hundreds of bytes after the
 *       optional `<?xml … ?>` declaration).
 *   4. `<?xml … ?>` + `<OFX>` → "ofx-xml".
 *   5. `.ofx` extension fallback → "ofx-sgml" (broker exports without the
 *       SGML headers but with `<OFX>` root still parse fine).
 *   6. Otherwise "unknown".
 */
export function detectInvestmentFileFormat(
  fileName: string,
  text: string,
): DetectResult {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const head = text.slice(0, 4096); // 4KB is plenty — IBKR/OFX preludes fit.

  // QFX → always "qfx" (extension is the contract).
  if (ext === "qfx") return { format: "qfx" };

  // SGML OFX header — `OFXHEADER:100` (or `OFXHEADER:200` rarely).
  if (/^\s*OFXHEADER\s*:/i.test(head) || /\bOFXHEADER:\d+/i.test(head.slice(0, 256))) {
    return { format: "ofx-sgml" };
  }

  // IBKR FlexQuery: distinctive root element.
  if (/<FlexQueryResponse\b/i.test(head)) {
    return { format: "ibkr-flex" };
  }

  // XML form OFX — `<?xml ?>` plus an `<OFX>` (sometimes `<OFX …>`) root.
  if (/<\?xml\b/i.test(head) && /<OFX[\s>]/i.test(head)) {
    return { format: "ofx-xml" };
  }

  // No SGML header, but OFX root and an `.ofx` extension — broker exports
  // without the prelude still parse via `parseOfx()`.
  if (ext === "ofx" && /<OFX[\s>]/i.test(head)) {
    return { format: "ofx-sgml" };
  }

  // `.xml` with no recognizable root — unknown. Caller surfaces an error.
  return { format: "unknown" };
}
