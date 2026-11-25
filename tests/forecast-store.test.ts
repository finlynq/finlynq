/**
 * Forecast scenario + snapshot store (DB-gated): encryption at rest, versions
 * and conflicts, revisions + revert, variants (resolution, cycles, delete
 * guard), snapshots, user isolation, Clear All Data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { TEST_DEK, bootstrapTestDb, resetTestDb, shutdownTestDb, createTestUser } from "./helpers/portfolio-fixtures";
import { db } from "@/db";
import { baselineScenario, scenarioConfigSchema } from "@/lib/forecast/config";
import { diffFromParent } from "@/lib/forecast/variants";
import { runForecast } from "@/lib/forecast/engine";
import type { ForecastInputs } from "@/lib/forecast/types";
import {
  createScenario, createSnapshot, deleteScenario, deleteSnapshot, getScenario, getSnapshot,
  listRevisions, listScenarios, listSnapshots, revertScenario, updateScenario,
} from "@/lib/forecast/store";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

const rows = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? (r as unknown[])) as Array<Record<string, unknown>>;

describeDb("forecast store", () => {
  let userId = "";
  let other = "";

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM forecast_snapshots`);
    await db.execute(sql`DELETE FROM forecast_scenario_revisions`);
    await db.execute(sql`DELETE FROM forecast_scenarios`);
    userId = await createTestUser();
    other = await createTestUser();
  });

  const base = (horizonMonths = 120) => ({ kind: "base" as const, config: baselineScenario(horizonMonths) });

  it("creates encrypted, lists, and refuses duplicates and bad docs", async () => {
    const r = await createScenario(userId, TEST_DEK, { name: "Secret plan", doc: base() });
    expect(r.ok).toBe(true);
    const raw = rows(await db.execute(sql`SELECT name_ct, doc_ct FROM forecast_scenarios WHERE user_id = ${userId}`))[0];
    expect(String(raw.name_ct)).toMatch(/^v1:/);
    expect(String(raw.doc_ct)).not.toContain("inflation");
    expect((await listScenarios(userId, TEST_DEK)).map((s) => s.name)).toEqual(["Secret plan"]);
    // Spacing is normalized before the name lookup, so this is the same name.
    expect(await createScenario(userId, TEST_DEK, { name: " Secret  plan ", doc: base() })).toMatchObject({ ok: false, code: "duplicate_name" });
    expect(await createScenario(userId, TEST_DEK, { name: "Other", doc: { kind: "base", config: { horizonMonths: 9999 } } })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("versions: a stale save is refused with the current version; revisions and revert", async () => {
    const c = await createScenario(userId, TEST_DEK, { name: "Plan", doc: base(60) });
    if (!c.ok) throw new Error();
    const id = c.scenario.id;
    const u1 = await updateScenario(userId, TEST_DEK, id, { doc: base(120), expectedVersion: 1, summary: "10 years" });
    expect(u1).toMatchObject({ ok: true, scenario: { version: 2, config: { horizonMonths: 120 } } });
    const stale = await updateScenario(userId, TEST_DEK, id, { doc: base(240), expectedVersion: 1 });
    expect(stale).toMatchObject({ ok: false, code: "version_conflict", currentVersion: 2 });
    const asAssistant = await updateScenario(userId, TEST_DEK, id, { doc: base(360), expectedVersion: 2, by: "assistant", summary: "30 years" });
    expect(asAssistant).toMatchObject({ ok: true, scenario: { version: 3, updatedBy: "assistant" } });
    expect((await listRevisions(userId, TEST_DEK, id)).map((r) => [r.version, r.summary, r.updatedBy])).toEqual([
      [3, "30 years", "assistant"], [2, "10 years", "user"], [1, "Created", "user"],
    ]);
    const back = await revertScenario(userId, TEST_DEK, id, 1, 3);
    expect(back).toMatchObject({ ok: true, scenario: { version: 4, config: { horizonMonths: 60 } } });
  });

  it("variants resolve through their parent, refuse loops, and block deleting the parent", async () => {
    const p = await createScenario(userId, TEST_DEK, { name: "Parent", doc: base(120) });
    if (!p.ok) throw new Error();
    const parentCfg = p.scenario.config!;
    const edited = scenarioConfigSchema.parse({ ...parentCfg, assumptions: { ...parentCfg.assumptions, investmentReturnPct: 7 } });
    const v = await createScenario(userId, TEST_DEK, {
      name: "Variant",
      doc: { kind: "variant", parent: { type: "scenario", id: p.scenario.id }, patch: diffFromParent(parentCfg, edited) },
    });
    if (!v.ok) throw new Error();
    expect(v.scenario.config).toMatchObject({ horizonMonths: 120, assumptions: { investmentReturnPct: 7 } });

    // A parent change flows into the variant.
    await updateScenario(userId, TEST_DEK, p.scenario.id, { doc: base(240), expectedVersion: 1 });
    expect((await getScenario(userId, TEST_DEK, v.scenario.id))!.config).toMatchObject({ horizonMonths: 240, assumptions: { investmentReturnPct: 7 } });

    // The parent can't become a variant of its own variant.
    const loop = await updateScenario(userId, TEST_DEK, p.scenario.id, {
      doc: { kind: "variant", parent: { type: "scenario", id: v.scenario.id }, patch: diffFromParent(parentCfg, parentCfg) },
      expectedVersion: 2,
    });
    expect(loop).toMatchObject({ ok: false, code: "invalid" });
    expect(await deleteScenario(userId, TEST_DEK, p.scenario.id)).toMatchObject({ ok: false, code: "has_variants" });
    expect(await deleteScenario(userId, TEST_DEK, v.scenario.id)).toEqual({ ok: true });
    expect(await deleteScenario(userId, TEST_DEK, p.scenario.id)).toEqual({ ok: true });
  });

  it("snapshots store a frozen result and read it back", async () => {
    const inputs: ForecastInputs = {
      inputsAsOf: "2026-11-25T12:00:00.000Z", today: "2026-11-25", startMonth: "2026-12", currency: "USD",
      maxHorizonMonths: 24, budgetHorizonEnd: "2029-10",
      lines: [{ key: "c:1", label: "Salary", type: "income", group: "Pay" }],
      budget: { "c:1": { months: { "2026-12": 100 }, carryFrom: null, carryAmount: null } },
      historyMonths: [], history: {}, pastBudget: {}, scheduled: {},
      loans: [], accounts: [{ id: 1, label: "Cash", pool: "cash", balance: 10 }], notes: [], leftOut: [],
    };
    const cfg = baselineScenario(12);
    const result = runForecast(inputs, cfg);
    const s = await createSnapshot(userId, TEST_DEK, { name: "Nov plan", result, config: cfg });
    expect(s).toMatchObject({ ok: true, snapshot: { name: "Nov plan", currency: "USD", startMonth: "2026-12", months: 12 } });
    if (!s.ok) throw new Error();
    const got = await getSnapshot(userId, TEST_DEK, s.snapshot.id);
    expect(got!.result).toEqual(result);
    expect(got!.config).toEqual(cfg);
    expect(await createSnapshot(userId, TEST_DEK, { name: "Bad", result: { nope: true }, config: cfg })).toMatchObject({ ok: false, code: "invalid" });
    expect(await createSnapshot(userId, TEST_DEK, { name: "Nov plan", result, config: cfg })).toMatchObject({ ok: false, code: "duplicate_name" });
    expect((await listSnapshots(other, TEST_DEK)).length).toBe(0);
    expect(await deleteSnapshot(other, s.snapshot.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await deleteSnapshot(userId, s.snapshot.id)).toEqual({ ok: true });
  });

  it("keeps users apart and reads nothing without a key", async () => {
    const c = await createScenario(userId, TEST_DEK, { name: "Mine", doc: base() });
    if (!c.ok) throw new Error();
    expect(await getScenario(other, TEST_DEK, c.scenario.id)).toBeNull();
    expect(await updateScenario(other, TEST_DEK, c.scenario.id, { doc: base(), expectedVersion: 1 })).toMatchObject({ code: "not_found" });
    const locked = await listScenarios(userId, null);
    expect(locked[0]).toMatchObject({ unreadable: true, name: "" });
  });
});
