/**
 * SERVER ONLY (reaches the database): never import into a client component.
 *
 * Saved forecast scenarios, their revisions, and saved snapshots
 * (plan/forecast-scenarios.md sections 8a + 9). The ONE place they are read
 * and written: REST now, MCP later (Phase 5).
 *
 * Names, scenario docs, snapshot results and their settings are encrypted
 * with the user's DEK, so writes need it. Reads take a nullable DEK: a row
 * this key can't read comes back `unreadable: true`.
 * Every save bumps `version`; a save with a stale `expectedVersion` is
 * refused (`version_conflict`, with the current version). Every save also
 * appends a revision (capped per scenario), which is how undo and "what did
 * the assistant change" work.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema, withDbTransaction } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";
import { pgErrorCode } from "@/lib/db-utils";
import { scenarioConfigSchema, scenarioDocSchema, type ScenarioConfig, type ScenarioDoc, type ScenarioParent } from "./config";
import { resolveDoc } from "./variants";
import { MAX_SNAPSHOT_BYTES, MAX_SNAPSHOTS_PER_USER, upgradeForecastResult } from "./snapshot";
import type { ForecastResult } from "./types";

const scenarios = schema.forecastScenarios;
const revisions = schema.forecastScenarioRevisions;
const snapshots = schema.forecastSnapshots;

export const MAX_SCENARIOS_PER_USER = 50;
export const MAX_REVISIONS_PER_SCENARIO = 50;
const MAX_NAME = 80;

export type Actor = "user" | "assistant";

export type StoreError = {
  ok: false;
  code: "invalid" | "duplicate_name" | "too_many" | "not_found" | "version_conflict" | "has_variants";
  error: string;
  currentVersion?: number;
};

export type ScenarioSummary = {
  id: number;
  name: string;
  kind: "base" | "variant";
  parent: ScenarioParent | null;
  version: number;
  updatedBy: Actor;
  updatedAt: string;
  unreadable: boolean;
};

export type ScenarioDetail = ScenarioSummary & {
  doc: ScenarioDoc | null;
  /** The full settings (a variant applied to its parent chain). */
  config: ScenarioConfig | null;
};

function checkName(raw: unknown): { ok: true; name: string } | StoreError {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, code: "invalid", error: "Give it a name." };
  if (name.length > MAX_NAME) return { ok: false, code: "invalid", error: `Keep the name under ${MAX_NAME} characters.` };
  return { ok: true, name };
}

const dup = (what: string): StoreError => ({ ok: false, code: "duplicate_name", error: `You already have a ${what} with that name. Pick another name.` });
const isUnique = (err: unknown) => pgErrorCode(err) === "23505";

type ScenarioRow = typeof scenarios.$inferSelect;

function decodeDoc(dek: Buffer | null, ct: string): ScenarioDoc | null {
  const json = dek ? tryDecryptField(dek, ct, "forecast-scenario-doc") : null;
  if (json == null) return null;
  try {
    const parsed = scenarioDocSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function summaryOf(dek: Buffer | null, r: ScenarioRow, doc: ScenarioDoc | null): ScenarioSummary {
  const name = dek ? tryDecryptField(dek, r.nameCt, "forecast-scenario-name") : null;
  return {
    id: r.id,
    name: name ?? "",
    kind: doc?.kind ?? (r.parentId != null ? "variant" : "base"),
    parent: doc?.kind === "variant" ? doc.parent : null,
    version: r.version,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
    unreadable: name == null || doc == null,
  };
}

async function loadAll(userId: string, dek: Buffer | null) {
  const rows = await db.select().from(scenarios).where(eq(scenarios.userId, userId)).orderBy(asc(scenarios.id));
  const docs = new Map<number, ScenarioDoc | null>(rows.map((r) => [r.id, decodeDoc(dek, r.docCt)]));
  return { rows, docs };
}

export async function listScenarios(userId: string, dek: Buffer | null): Promise<ScenarioSummary[]> {
  const { rows, docs } = await loadAll(userId, dek);
  return rows
    .map((r) => summaryOf(dek, r, docs.get(r.id) ?? null))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function getScenario(userId: string, dek: Buffer | null, id: number): Promise<ScenarioDetail | null> {
  const { rows, docs } = await loadAll(userId, dek);
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const doc = docs.get(id) ?? null;
  const config = doc ? resolveDoc(doc, (pid) => docs.get(pid) ?? null) : null;
  return { ...summaryOf(dek, row, doc), doc, config };
}

/** Would making `parentId` the parent of `id` create a loop? */
function makesCycle(docs: Map<number, ScenarioDoc | null>, id: number | null, parentId: number): boolean {
  let cur: number | null = parentId;
  const seen = new Set<number>();
  while (cur != null) {
    if (cur === id || seen.has(cur)) return true;
    seen.add(cur);
    const d = docs.get(cur);
    cur = d?.kind === "variant" && d.parent.type === "scenario" ? d.parent.id : null;
  }
  return false;
}

function parentIdOf(doc: ScenarioDoc): number | null {
  return doc.kind === "variant" && doc.parent.type === "scenario" ? doc.parent.id : null;
}

async function addRevision(
  userId: string,
  dek: Buffer,
  scenarioId: number,
  version: number,
  docCt: string,
  by: Actor,
  summary: string | undefined,
) {
  await db.insert(revisions).values({
    userId,
    scenarioId,
    version,
    docCt,
    summaryCt: summary ? encryptField(dek, summary.slice(0, 300)) : null,
    updatedBy: by,
  });
  // Keep the newest MAX_REVISIONS_PER_SCENARIO.
  await db.execute(sql`
    DELETE FROM forecast_scenario_revisions
     WHERE scenario_id = ${scenarioId} AND user_id = ${userId}
       AND id NOT IN (
         SELECT id FROM forecast_scenario_revisions
          WHERE scenario_id = ${scenarioId} AND user_id = ${userId}
          ORDER BY version DESC, id DESC LIMIT ${MAX_REVISIONS_PER_SCENARIO}
       )
  `);
}

export async function createScenario(
  userId: string,
  dek: Buffer,
  input: { name: unknown; doc: unknown; by?: Actor; summary?: string },
): Promise<{ ok: true; scenario: ScenarioDetail } | StoreError> {
  const name = checkName(input.name);
  if (!name.ok) return name;
  const parsed = scenarioDocSchema.safeParse(input.doc);
  if (!parsed.success) return { ok: false, code: "invalid", error: "Those scenario settings aren't valid." };
  const doc = parsed.data;
  const { rows } = await loadAll(userId, dek);
  if (rows.length >= MAX_SCENARIOS_PER_USER) {
    return { ok: false, code: "too_many", error: `You can keep up to ${MAX_SCENARIOS_PER_USER} scenarios. Delete one first.` };
  }
  const parentId = parentIdOf(doc);
  if (parentId != null && !rows.some((r) => r.id === parentId)) {
    return { ok: false, code: "not_found", error: "The scenario this is based on doesn't exist." };
  }
  const by = input.by ?? "user";
  const nameFields = buildNameFields(dek, { name: name.name }) as { nameCt: string; nameLookup: string };
  const docCt = encryptField(dek, JSON.stringify(doc))!;
  try {
    const id = await withDbTransaction(async () => {
      const [row] = await db
        .insert(scenarios)
        .values({ userId, nameCt: nameFields.nameCt, nameLookup: nameFields.nameLookup, parentId, docCt, updatedBy: by })
        .returning({ id: scenarios.id });
      await addRevision(userId, dek, row.id, 1, docCt, by, input.summary ?? "Created");
      return row.id;
    });
    return { ok: true, scenario: (await getScenario(userId, dek, id))! };
  } catch (err) {
    if (isUnique(err)) return dup("scenario");
    throw err;
  }
}

export async function updateScenario(
  userId: string,
  dek: Buffer,
  id: number,
  input: { name?: unknown; doc?: unknown; expectedVersion: number; by?: Actor; summary?: string },
): Promise<{ ok: true; scenario: ScenarioDetail } | StoreError> {
  const { rows, docs } = await loadAll(userId, dek);
  const row = rows.find((r) => r.id === id);
  if (!row) return { ok: false, code: "not_found", error: "No such scenario." };
  if (row.version !== input.expectedVersion) {
    return { ok: false, code: "version_conflict", error: "This scenario changed since you opened it. Reload it and try again.", currentVersion: row.version };
  }
  const set: Partial<typeof scenarios.$inferInsert> = { updatedAt: new Date(), version: row.version + 1, updatedBy: input.by ?? "user" };
  if (input.name !== undefined) {
    const name = checkName(input.name);
    if (!name.ok) return name;
    const f = buildNameFields(dek, { name: name.name }) as { nameCt: string; nameLookup: string };
    set.nameCt = f.nameCt;
    set.nameLookup = f.nameLookup;
  }
  let docCt = row.docCt;
  if (input.doc !== undefined) {
    const parsed = scenarioDocSchema.safeParse(input.doc);
    if (!parsed.success) return { ok: false, code: "invalid", error: "Those scenario settings aren't valid." };
    const parentId = parentIdOf(parsed.data);
    if (parentId != null) {
      if (!rows.some((r) => r.id === parentId)) return { ok: false, code: "not_found", error: "The scenario this is based on doesn't exist." };
      if (makesCycle(docs, id, parentId)) return { ok: false, code: "invalid", error: "A scenario can't be based on itself or on one of its own variants." };
    }
    docCt = encryptField(dek, JSON.stringify(parsed.data))!;
    set.docCt = docCt;
    set.parentId = parentId;
  }
  try {
    await withDbTransaction(async () => {
      const updated = await db
        .update(scenarios)
        .set(set)
        .where(and(eq(scenarios.userId, userId), eq(scenarios.id, id), eq(scenarios.version, input.expectedVersion)))
        .returning({ id: scenarios.id });
      if (!updated.length) throw new VersionRace();
      await addRevision(userId, dek, id, row.version + 1, docCt, input.by ?? "user", input.summary);
    });
  } catch (err) {
    if (err instanceof VersionRace) {
      return { ok: false, code: "version_conflict", error: "This scenario changed since you opened it. Reload it and try again." };
    }
    if (isUnique(err)) return dup("scenario");
    throw err;
  }
  return { ok: true, scenario: (await getScenario(userId, dek, id))! };
}

class VersionRace extends Error {}

export async function deleteScenario(userId: string, dek: Buffer | null, id: number): Promise<{ ok: true } | StoreError> {
  const { rows, docs } = await loadAll(userId, dek);
  if (!rows.some((r) => r.id === id)) return { ok: false, code: "not_found", error: "No such scenario." };
  const children = rows.filter((r) => r.parentId === id);
  if (children.length) {
    const names = children.map((r) => summaryOf(dek, r, docs.get(r.id) ?? null).name || `#${r.id}`);
    return { ok: false, code: "has_variants", error: `Delete or detach its variants first: ${names.join(", ")}.` };
  }
  await db.delete(scenarios).where(and(eq(scenarios.userId, userId), eq(scenarios.id, id)));
  return { ok: true };
}

export async function listRevisions(userId: string, dek: Buffer | null, id: number) {
  const rows = await db
    .select({ version: revisions.version, summaryCt: revisions.summaryCt, updatedBy: revisions.updatedBy, createdAt: revisions.createdAt })
    .from(revisions)
    .where(and(eq(revisions.userId, userId), eq(revisions.scenarioId, id)))
    .orderBy(desc(revisions.version));
  return rows.map((r) => ({
    version: r.version,
    summary: r.summaryCt && dek ? tryDecryptField(dek, r.summaryCt, "forecast-revision-summary") : null,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Put a scenario back to an earlier revision (saved as a NEW version). */
export async function revertScenario(
  userId: string,
  dek: Buffer,
  id: number,
  toVersion: number,
  expectedVersion: number,
  by: Actor = "user",
): Promise<{ ok: true; scenario: ScenarioDetail } | StoreError> {
  const [rev] = await db
    .select({ docCt: revisions.docCt })
    .from(revisions)
    .where(and(eq(revisions.userId, userId), eq(revisions.scenarioId, id), eq(revisions.version, toVersion)))
    .limit(1);
  if (!rev) return { ok: false, code: "not_found", error: "That version is no longer kept." };
  const doc = decodeDoc(dek, rev.docCt);
  if (!doc) return { ok: false, code: "invalid", error: "That version can't be read with your key." };
  return updateScenario(userId, dek, id, { doc, expectedVersion, by, summary: `Back to version ${toVersion}` });
}

// ── Snapshots ─────────────────────────────────────────────────────────────

export type SnapshotSummary = {
  id: number;
  name: string;
  scenarioId: number | null;
  currency: string | null;
  startMonth: string | null;
  months: number | null;
  inputsAsOf: string;
  resultSchemaVersion: number;
  engineVersion: number;
  createdBy: Actor;
  createdAt: string;
  unreadable: boolean;
};

type SnapshotRow = typeof snapshots.$inferSelect;

function snapSummary(dek: Buffer | null, r: SnapshotRow, result: ForecastResult | null): SnapshotSummary {
  const name = dek ? tryDecryptField(dek, r.nameCt, "forecast-snapshot-name") : null;
  return {
    id: r.id,
    name: name ?? "",
    scenarioId: r.scenarioId,
    currency: result?.currency ?? null,
    startMonth: result?.startMonth ?? null,
    months: result?.months.length ?? null,
    inputsAsOf: r.inputsAsOf.toISOString(),
    resultSchemaVersion: r.resultSchemaVersion,
    engineVersion: r.engineVersion,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    unreadable: name == null,
  };
}

function decodeResult(dek: Buffer | null, ct: string): ForecastResult | null {
  const json = dek ? tryDecryptField(dek, ct, "forecast-snapshot-result") : null;
  if (json == null) return null;
  try {
    return upgradeForecastResult(JSON.parse(json));
  } catch {
    return null;
  }
}

export async function listSnapshots(userId: string, dek: Buffer | null): Promise<SnapshotSummary[]> {
  const rows = await db.select().from(snapshots).where(eq(snapshots.userId, userId)).orderBy(desc(snapshots.createdAt));
  // The list shows currency/start/length, which live in the (encrypted) result;
  // results are small enough to decode for a list of at most 50.
  return rows.map((r) => snapSummary(dek, r, decodeResult(dek, r.resultCt)));
}

export async function getSnapshot(userId: string, dek: Buffer | null, id: number) {
  const [row] = await db.select().from(snapshots).where(and(eq(snapshots.userId, userId), eq(snapshots.id, id))).limit(1);
  if (!row) return null;
  const result = decodeResult(dek, row.resultCt);
  let config: ScenarioConfig | null = null;
  const cjson = dek ? tryDecryptField(dek, row.configCt, "forecast-snapshot-config") : null;
  if (cjson) {
    try {
      const p = scenarioConfigSchema.safeParse(JSON.parse(cjson));
      config = p.success ? p.data : null;
    } catch {
      config = null;
    }
  }
  return { ...snapSummary(dek, row, result), result, config };
}

export async function createSnapshot(
  userId: string,
  dek: Buffer,
  input: { name: unknown; scenarioId?: number | null; result: unknown; config: unknown; by?: Actor },
): Promise<{ ok: true; snapshot: SnapshotSummary } | StoreError> {
  const name = checkName(input.name);
  if (!name.ok) return name;
  const result = upgradeForecastResult(input.result);
  if (!result) return { ok: false, code: "invalid", error: "That forecast result isn't valid." };
  const config = scenarioConfigSchema.safeParse(input.config);
  if (!config.success) return { ok: false, code: "invalid", error: "Those scenario settings aren't valid." };
  const resultJson = JSON.stringify(result);
  if (resultJson.length > MAX_SNAPSHOT_BYTES) return { ok: false, code: "invalid", error: "That forecast is too large to save." };
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(snapshots).where(eq(snapshots.userId, userId));
  if (Number(count) >= MAX_SNAPSHOTS_PER_USER) {
    return { ok: false, code: "too_many", error: `You can keep up to ${MAX_SNAPSHOTS_PER_USER} snapshots. Delete one first.` };
  }
  let scenarioId: number | null = null;
  if (input.scenarioId != null) {
    const [own] = await db.select({ id: scenarios.id }).from(scenarios)
      .where(and(eq(scenarios.userId, userId), eq(scenarios.id, input.scenarioId))).limit(1);
    scenarioId = own ? own.id : null;
  }
  const f = buildNameFields(dek, { name: name.name }) as { nameCt: string; nameLookup: string };
  try {
    const [row] = await db
      .insert(snapshots)
      .values({
        userId,
        scenarioId,
        nameCt: f.nameCt,
        nameLookup: f.nameLookup,
        resultCt: encryptField(dek, resultJson)!,
        configCt: encryptField(dek, JSON.stringify(config.data))!,
        resultSchemaVersion: result.resultSchemaVersion,
        engineVersion: result.engineVersion,
        inputsAsOf: new Date(result.inputsAsOf),
        createdBy: input.by ?? "user",
      })
      .returning();
    return { ok: true, snapshot: snapSummary(dek, row, result) };
  } catch (err) {
    if (isUnique(err)) return dup("snapshot");
    throw err;
  }
}

export async function deleteSnapshot(userId: string, id: number): Promise<{ ok: true } | StoreError> {
  const deleted = await db.delete(snapshots).where(and(eq(snapshots.userId, userId), eq(snapshots.id, id))).returning({ id: snapshots.id });
  return deleted.length ? { ok: true } : { ok: false, code: "not_found", error: "No such snapshot." };
}

