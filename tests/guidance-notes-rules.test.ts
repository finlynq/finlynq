/** FINLYNQ-219: the pure rules for a user's guidance notes, and the Markdown reader. */
import { describe, it, expect } from "vitest";
import { checkNote, normalizeNotePath, notePathError, noteConflictMessage, NOTE_MAX_TOKENS } from "@/lib/guides/notes-rules";
import { parseMarkdown, parseInline } from "@/lib/guides/markdown";

const base = { path: "banks/rbc-chequing.md", title: "RBC chequing", body: "Amounts in the CSV have reversed signs." };

describe("note paths", () => {
  it("normalises what a person types", () => {
    expect(normalizeNotePath("  Banks/RBC-Chequing ")).toBe("banks/rbc-chequing.md");
    expect(normalizeNotePath("/payees.md")).toBe("payees.md");
    expect(normalizeNotePath("a\\b")).toBe("a/b.md");
  });

  it("accepts folders and rejects anything that could escape or look odd", () => {
    expect(notePathError("banks/rbc-chequing.md")).toBeNull();
    expect(notePathError("payees_2026.md")).toBeNull();
    for (const bad of ["", "../x.md", "a//b.md", "a b.md", "-x.md", "x.txt", "a/.md", "a/../b.md"]) {
      expect(notePathError(bad), bad).not.toBeNull();
    }
    expect(notePathError("a".repeat(118) + ".md")).not.toBeNull();
  });
});

describe("checkNote", () => {
  it("returns a tidied note", () => {
    const r = checkNote({ ...base, title: "  RBC chequing ", summary: "  ", body: "line\r\n\r\nmore\n" });
    expect(r).toEqual({ ok: true, note: { path: "banks/rbc-chequing.md", title: "RBC chequing", summary: null, body: "line\n\nmore" } });
  });

  it("refuses an empty title or body", () => {
    expect(checkNote({ ...base, title: " " }).ok).toBe(false);
    expect(checkNote({ ...base, body: "\n " }).ok).toBe(false);
  });

  it("refuses a note over the size cap and says how big it is", () => {
    const r = checkNote({ ...base, body: "x".repeat(NOTE_MAX_TOKENS * 4 + 4) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too long.*Split it/);
    expect(checkNote({ ...base, body: "x".repeat(NOTE_MAX_TOKENS * 4) }).ok).toBe(true);
  });

  it("refuses a long title or summary", () => {
    expect(checkNote({ ...base, title: "t".repeat(121) }).ok).toBe(false);
    expect(checkNote({ ...base, summary: "s".repeat(201) }).ok).toBe(false);
  });

  it("explains a conflict both ways", () => {
    expect(noteConflictMessage(3)).toMatch(/version 3/);
    expect(noteConflictMessage(0)).toMatch(/no longer exists/);
  });
});

describe("parseMarkdown", () => {
  it("reads headings, paragraphs, lists and code", () => {
    const blocks = parseMarkdown("# Title\n\nSome `code` and **bold**\ncontinued.\n\n- one\n- two\n  wrapped\n\n1. first\n2. second\n\n```\nraw *text*\n```\n");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list", "code"]);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      parts: [
        { kind: "text", text: "Some " },
        { kind: "code", text: "code" },
        { kind: "text", text: " and " },
        { kind: "bold", text: "bold" },
        { kind: "text", text: " continued." },
      ],
    });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: false });
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
    expect(parseInline("one two wrapped")).toEqual([{ kind: "text", text: "one two wrapped" }]);
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[4]).toEqual({ kind: "code", text: "raw *text*" });
  });

  it("leaves HTML as plain text (it is rendered as text, never injected)", () => {
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "paragraph", parts: [{ kind: "text", text: "<img src=x onerror=alert(1)>" }] },
    ]);
  });
});
