/**
 * FINLYNQ-188 — the module-level file-handoff store that carries the dashboard
 * Quick Import file across a client-side navigation to /import.
 *
 * The store is single-slot and clears-on-read, so /import consumes the carried
 * file exactly once (a refresh / repeat mount won't re-fire the upload). These
 * tests are the deterministic anchor for that contract — the browser-driven
 * cases (tc-1..tc-3) exercise the end-to-end UI.
 */

import { afterEach, describe, expect, it } from "vitest";
import { setHandoffFile, takeHandoffFile } from "../src/lib/import/file-handoff";

// Defend against state leaking between tests if one forgets to drain.
afterEach(() => {
  takeHandoffFile();
});

function makeFile(name: string): File {
  return new File(["date,amount\n2026-06-17,12.34\n"], name, {
    type: "text/csv",
  });
}

describe("import file-handoff store", () => {
  it("returns null when nothing has been stashed", () => {
    expect(takeHandoffFile()).toBeNull();
  });

  it("returns the stashed file then clears the slot (consume-once)", () => {
    const f = makeFile("statement.csv");
    setHandoffFile(f);
    expect(takeHandoffFile()).toBe(f);
    // Second read is empty — a refresh / repeat mount must not re-fire.
    expect(takeHandoffFile()).toBeNull();
  });

  it("last write wins (single slot)", () => {
    const a = makeFile("a.csv");
    const b = makeFile("b.ofx");
    setHandoffFile(a);
    setHandoffFile(b);
    expect(takeHandoffFile()).toBe(b);
    expect(takeHandoffFile()).toBeNull();
  });

  it("supports re-selecting the same filename (new File ref each pick)", () => {
    const first = makeFile("same.csv");
    setHandoffFile(first);
    expect(takeHandoffFile()).toBe(first);
    const second = makeFile("same.csv");
    setHandoffFile(second);
    expect(takeHandoffFile()).toBe(second);
  });
});
