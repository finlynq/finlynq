/**
 * file-handoff — a tiny module-level in-memory store for carrying a single
 * picked/dropped `File` across a client-side navigation (FINLYNQ-188).
 *
 * The dashboard Quick Import card lets the user pick (or drop) a CSV/OFX/QFX
 * file, then navigates to `/import`. A `File` is NOT JSON-serializable, so it
 * can't ride through `sessionStorage` or the URL — but the JS module instance
 * survives a Next.js client-side `router.push` (no full page reload), so a
 * module-level variable is the cleanest hand-off. `/import` reads it once on
 * mount via `takeHandoffFile()` (which clears the slot so a refresh / repeat
 * mount doesn't re-trigger the upload), opens its UploadDrawer, and feeds the
 * file into the SAME preview/staging pipeline the drawer already runs.
 *
 * Single-slot by design: the last file written wins. Cleared on read so the
 * file is consumed exactly once.
 */

let pendingFile: File | null = null;

/** Stash a file to be consumed by `/import` on its next mount. */
export function setHandoffFile(file: File): void {
  pendingFile = file;
}

/**
 * Consume the stashed file, clearing the slot. Returns `null` when nothing was
 * stashed (the normal case when `/import` is opened directly). Clearing on read
 * means a page refresh or a second mount won't re-fire the carried upload.
 */
export function takeHandoffFile(): File | null {
  const f = pendingFile;
  pendingFile = null;
  return f;
}
