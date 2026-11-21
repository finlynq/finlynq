/**
 * GH #428 (2026-11-21) — "Not a subscription" for a detected suggestion.
 *
 * Pure part: matching ignores case and spacing, needs the key, and leaves
 * everything else alone. Static part: every place that builds the detected
 * list reads the dismissals. DB part (finlynq_test lane): the store and the
 * MCP ops, encryption at rest, and that a dismissal survives deleting a
 * subscription of the same name.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { nameLookup } from "@/lib/crypto/encrypted-columns";
import { withoutDismissed, dismissPayees, listDismissals, undismiss, dismissedLookups } from "@/lib/subscriptions/dismissals";
import { registerPgTools } from "../mcp-server/register-tools-pg";
import { TEST_DEK, bootstrapTestDb, resetTestDb, shutdownTestDb, createTestUser } from "./helpers/portfolio-fixtures";
import { db } from "@/db";
import { clearAllUserData } from "@/lib/auth/queries";

const dek = randomBytes(32);

describe("withoutDismissed", () => {
  const rows = [{ payee: "Hydro One" }, { payee: "Netflix" }, { payee: "" }];

  it("drops a dismissed payee whatever its case or spacing", () => {
    const set = new Set([nameLookup(dek, "  hydro   ONE ")]);
    expect(withoutDismissed(rows, (r) => r.payee, set, dek).map((r) => r.payee)).toEqual(["Netflix", ""]);
  });

  it("changes nothing with no dismissals or no key", () => {
    const set = new Set([nameLookup(dek, "Hydro One")]);
    expect(withoutDismissed(rows, (r) => r.payee, new Set(), dek)).toEqual(rows);
    expect(withoutDismissed(rows, (r) => r.payee, set, null)).toEqual(rows);
  });

  it("a different user's key never matches", () => {
    const other = randomBytes(32);
    const set = new Set([nameLookup(other, "Hydro One")]);
    expect(withoutDismissed(rows, (r) => r.payee, set, dek)).toEqual(rows);
  });
});

describe("every detected list reads the dismissals", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it.each([
    ["src/app/api/recurring/route.ts"],
    ["src/app/api/subscriptions/route.ts"],
    ["mcp-server/tools/subscriptions.ts"],
  ])("%s filters through withoutDismissed(… dismissedLookups …)", (file) => {
    const src = read(file);
    expect(src).toMatch(/withoutDismissed\(/);
    expect(src).toMatch(/dismissedLookups\(userId\)/);
  });

  it("the dashboard's monthly recurring total still counts dismissed payees", () => {
    const src = read("src/app/api/recurring/route.ts");
    // The total is built from `detected` BEFORE the dismissal filter.
    expect(src.indexOf("const monthlyRecurring = detected")).toBeGreaterThan(-1);
    expect(src.indexOf("const monthlyRecurring = detected")).toBeLessThan(src.indexOf("const listed = withoutDismissed"));
  });
});

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
function tools(userId: string, key: Buffer | null) {
  const server = new McpServer({ name: "dismissals-test", version: "0.0.0" });
  registerPgTools(server, db as never, userId, key as Buffer);
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
  return async (tool: string, args: Record<string, unknown>) => {
    const text = (await reg[tool].handler(args, {})).content[0].text;
    try { return JSON.parse(text); } catch { return { success: false, text }; }
  };
}

describeDb("subscription dismissals (DB)", () => {
  let userId = "";
  beforeAll(async () => { await bootstrapTestDb(); });
  afterAll(async () => { await shutdownTestDb(); });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM subscription_dismissals`);
    userId = await createTestUser();
  });

  it("dismisses once per payee, stores it encrypted, and undoes by id or name", async () => {
    expect(await dismissPayees(userId, TEST_DEK, ["Hydro One", "hydro  one", "Rogers"])).toEqual({ added: 2 });
    expect(await dismissPayees(userId, TEST_DEK, ["HYDRO ONE"])).toEqual({ added: 0 });

    const raw = await db.execute(sql`SELECT payee_ct FROM subscription_dismissals WHERE user_id = ${userId}`);
    const cts = (raw as unknown as { rows: { payee_ct: string }[] }).rows.map((r) => r.payee_ct);
    expect(cts.every((c) => c.startsWith("v1:") && !c.includes("Hydro"))).toBe(true);

    const list = await listDismissals(userId, TEST_DEK);
    expect(list.map((d) => d.payee).sort()).toEqual(["Hydro One", "Rogers"]);
    expect((await listDismissals(userId, null)).every((d) => d.payee === null)).toBe(true);

    const hydro = list.find((d) => d.payee === "Hydro One")!;
    expect(await undismiss(userId, null, { ids: [hydro.id] })).toEqual({ removed: 1 });
    expect(await undismiss(userId, TEST_DEK, { payees: ["rogers"] })).toEqual({ removed: 1 });
    expect((await dismissedLookups(userId)).size).toBe(0);
  });

  it("another user's dismissal can't be undone or seen", async () => {
    await dismissPayees(userId, TEST_DEK, ["Hydro One"]);
    const other = await createTestUser();
    const [mine] = await listDismissals(userId, TEST_DEK);
    expect(await undismiss(other, TEST_DEK, { ids: [mine.id] })).toEqual({ removed: 0 });
    expect(await listDismissals(other, TEST_DEK)).toEqual([]);
  });

  it("MCP manage_subscriptions dismiss / list / undismiss", async () => {
    const call = tools(userId, TEST_DEK);
    const d = await call("manage_subscriptions", { op: "dismiss_suggestion", payees: ["Costco"] });
    expect(d).toMatchObject({ success: true, data: { added: 1 } });
    const l = await call("manage_subscriptions", { op: "list_dismissed" });
    expect(l.data.dismissals.map((x: { payee: string }) => x.payee)).toEqual(["Costco"]);
    const u = await call("manage_subscriptions", { op: "undismiss_suggestion", payees: ["costco"] });
    expect(u).toMatchObject({ success: true, data: { removed: 1 } });

    const locked = tools(userId, null);
    const refused = await locked("manage_subscriptions", { op: "dismiss_suggestion", payees: ["Costco"] });
    expect(refused.success).toBe(false);
  });

  it("deleting a subscription of the same name keeps the dismissal; Clear All Data removes it", async () => {
    await dismissPayees(userId, TEST_DEK, ["Hydro One"]);
    await db.execute(sql`DELETE FROM subscriptions WHERE user_id = ${userId}`);
    expect((await dismissedLookups(userId)).size).toBe(1);
    await clearAllUserData(userId);
    expect((await dismissedLookups(userId)).size).toBe(0);
  });
});
