/**
 * FINLYNQ-219: a user's guidance notes against a real database, through the
 * store (what Settings → AI guidance calls) and the MCP tools (what an
 * assistant calls).
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../mcp-server/register-tools-pg";
import { TEST_DEK, bootstrapTestDb, resetTestDb, shutdownTestDb, createTestUser } from "./helpers/portfolio-fixtures";
import { db } from "@/db";
import { listNotes, noteHistory, readNote, retireNote, saveNote } from "@/lib/guides/notes-store";
import { NOTE_MAX_ACTIVE } from "@/lib/guides/notes-rules";
import { clearAllUserData } from "@/lib/auth/queries";
import { GUIDE_MODULE_IDS } from "@/lib/guides/registry";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;

function tools(userId: string, dek: Buffer | null) {
  const server = new McpServer({ name: "guidance-test", version: "0.0.0" });
  registerPgTools(server, db as never, userId, dek as Buffer);
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
  return async (tool: string, args: Record<string, unknown>) => {
    const text = (await reg[tool].handler(args, {})).content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return { success: false, text };
    }
  };
}

const note = { path: "banks/rbc-chequing.md", title: "RBC chequing", summary: "Signs reversed", body: "Amounts in the RBC CSV have reversed signs." };

describeDb("guidance notes", () => {
  let userId = "";

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM user_guidance_note_revisions`);
    await db.execute(sql`DELETE FROM user_guidance_notes`);
    userId = await createTestUser();
  });

  it("creates at version 1, updates with the current version, refuses a stale one", async () => {
    const created = await saveNote(userId, TEST_DEK, { ...note, expectedVersion: 0, by: "user" });
    expect(created).toMatchObject({ ok: true, note: { version: 1, path: note.path, updatedBy: "user" } });

    const again = await saveNote(userId, TEST_DEK, { ...note, expectedVersion: 0, by: "assistant" });
    expect(again).toMatchObject({ ok: false, code: "version_conflict", currentVersion: 1 });

    const updated = await saveNote(userId, TEST_DEK, { ...note, body: "Updated.", expectedVersion: 1, by: "assistant" });
    expect(updated).toMatchObject({ ok: true, note: { version: 2, body: "Updated.", updatedBy: "assistant" } });

    const stale = await saveNote(userId, TEST_DEK, { ...note, body: "Lost edit", expectedVersion: 1, by: "user" });
    expect(stale).toMatchObject({ ok: false, code: "version_conflict", currentVersion: 2 });
    expect((await readNote(userId, TEST_DEK, { path: note.path }))!.body).toBe("Updated.");
  });

  it("retire hides the note, keeps its history, and frees the path", async () => {
    const c = await saveNote(userId, TEST_DEK, { ...note, expectedVersion: 0, by: "user" });
    if (!c.ok) throw new Error("save failed");
    await saveNote(userId, TEST_DEK, { ...note, body: "v2", expectedVersion: 1, by: "user" });
    expect(await retireNote(userId, TEST_DEK, { id: c.note.id, expectedVersion: 1, by: "user" })).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await retireNote(userId, TEST_DEK, { id: c.note.id, expectedVersion: 2, by: "user" })).toMatchObject({ ok: true });

    expect(await listNotes(userId, TEST_DEK)).toEqual([]);
    expect(await readNote(userId, TEST_DEK, { id: c.note.id })).toBeNull();
    const history = await noteHistory(userId, TEST_DEK, c.note.id);
    expect(history.map((h) => [h.version, h.action])).toEqual([[2, "retire"], [2, "save"], [1, "save"]]);

    expect(await saveNote(userId, TEST_DEK, { ...note, expectedVersion: 0, by: "user" })).toMatchObject({ ok: true, note: { version: 1 } });
  });

  it("stores every text column encrypted", async () => {
    await saveNote(userId, TEST_DEK, { ...note, expectedVersion: 0, by: "user" });
    const rows = (await db.execute(sql`SELECT * FROM user_guidance_notes WHERE user_id = ${userId}`)) as unknown as { rows: Record<string, unknown>[] };
    const row = rows.rows[0];
    for (const col of ["path_ct", "title_ct", "summary_ct", "body_ct"]) expect(String(row[col])).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain("reversed signs");
    expect(JSON.stringify(row)).not.toContain("rbc-chequing");
    const revs = (await db.execute(sql`SELECT body_ct FROM user_guidance_note_revisions WHERE user_id = ${userId}`)) as unknown as { rows: Record<string, unknown>[] };
    expect(String(revs.rows[0].body_ct)).toMatch(/^v1:/);
  });

  it("refuses invalid notes and the 101st note", async () => {
    expect(await saveNote(userId, TEST_DEK, { ...note, path: "../x.md", expectedVersion: 0, by: "user" })).toMatchObject({ ok: false, code: "invalid" });
    for (let i = 0; i < NOTE_MAX_ACTIVE; i++) {
      const r = await saveNote(userId, TEST_DEK, { ...note, path: `n/${i}.md`, expectedVersion: 0, by: "user" });
      expect(r.ok).toBe(true);
    }
    expect(await saveNote(userId, TEST_DEK, { ...note, path: "n/extra.md", expectedVersion: 0, by: "user" })).toMatchObject({ ok: false, code: "too_many" });
  });

  it("keeps users apart", async () => {
    const other = await createTestUser();
    const c = await saveNote(userId, TEST_DEK, { ...note, expectedVersion: 0, by: "user" });
    if (!c.ok) throw new Error("save failed");
    expect(await readNote(other, TEST_DEK, { id: c.note.id })).toBeNull();
    expect(await retireNote(other, TEST_DEK, { id: c.note.id, expectedVersion: 1, by: "user" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await noteHistory(other, TEST_DEK, c.note.id)).toEqual([]);
    // The other user can use the same path for their own note.
    expect(await saveNote(other, TEST_DEK, { ...note, expectedVersion: 0, by: "user" })).toMatchObject({ ok: true });
    expect((await readNote(userId, TEST_DEK, { id: c.note.id }))!.body).toBe(note.body);
  });

  it("Clear All Data removes notes and their history", async () => {
    await saveNote(userId, TEST_DEK, { ...note, expectedVersion: 0, by: "user" });
    await clearAllUserData(userId);
    const n = (await db.execute(sql`SELECT count(*)::int AS c FROM user_guidance_notes WHERE user_id = ${userId}`)) as unknown as { rows: { c: number }[] };
    const r = (await db.execute(sql`SELECT count(*)::int AS c FROM user_guidance_note_revisions WHERE user_id = ${userId}`)) as unknown as { rows: { c: number }[] };
    expect([n.rows[0].c, r.rows[0].c]).toEqual([0, 0]);
  });

  describe("MCP", () => {
    it("get_guidance lists the guides and the user's notes, without bodies", async () => {
      const call = tools(userId, TEST_DEK);
      const saved = await call("manage_guidance_notes", { op: "save", ...note, expected_version: 0 });
      expect(saved).toMatchObject({ success: true, data: { op: "save", note: { version: 1, updatedBy: "assistant" } } });
      expect(saved.data.note.body).toBeUndefined();

      const index = await call("get_guidance", {});
      expect(index.data.guides.map((g: { id: string }) => g.id)).toEqual(GUIDE_MODULE_IDS);
      expect(index.data.notes).toEqual([expect.objectContaining({ path: note.path, title: note.title, summary: note.summary, version: 1 })]);
      expect(index.data.notes[0].body).toBeUndefined();
      expect(index.data.notesLocked).toBe(false);

      const one = await call("get_guidance", { note_path: note.path });
      expect(one.data).toMatchObject({ kind: "note", markdown: note.body });
      const guide = await call("get_guidance", { module: "reconcile" });
      expect(guide.data.markdown).toContain("# Reconciling a bank statement");
    });

    it("refuses a stale save and retires at the current version", async () => {
      const call = tools(userId, TEST_DEK);
      await call("manage_guidance_notes", { op: "save", ...note, expected_version: 0 });
      const stale = await call("manage_guidance_notes", { op: "save", ...note, body: "x", expected_version: 0 });
      expect(stale.text).toMatch(/already exists.*current version: 1/);
      const retired = await call("manage_guidance_notes", { op: "retire", note_path: note.path, expected_version: 1 });
      expect(retired.success).toBe(true);
      expect((await call("get_guidance", {})).data.notes).toEqual([]);
    });

    it("without a key: guides still listed, notes refused", async () => {
      const call = tools(userId, null);
      const index = await call("get_guidance", {});
      expect(index.data.guides.length).toBe(GUIDE_MODULE_IDS.length);
      expect(index.data).toMatchObject({ notes: null, notesLocked: true });
      expect((await call("get_guidance", { module: "loans" })).data.markdown).toContain("# Loans");
      expect((await call("get_guidance", { note_path: note.path })).text).toMatch(/encrypted/);
      expect((await call("manage_guidance_notes", { op: "save", ...note, expected_version: 0 })).text).toMatch(/encrypted/);
    });
  });
});
