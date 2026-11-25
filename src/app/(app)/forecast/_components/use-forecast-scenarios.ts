"use client";

/**
 * Scenario + snapshot state for the forecast page: which scenario is open,
 * its saved settings vs the settings being edited, and the save / save as /
 * variant / rename / delete / history / freeze calls. The page edits a FULL
 * config; saving a variant stores only its differences (variants.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { baselineScenario, type ScenarioConfig, type ScenarioDoc, type ScenarioParent } from "@/lib/forecast/config";
import { diffFromParent } from "@/lib/forecast/variants";
import type { ForecastResult } from "@/lib/forecast/types";

export type ScenarioSummary = {
  id: number;
  name: string;
  kind: "base" | "variant";
  parent: ScenarioParent | null;
  version: number;
  updatedBy: "user" | "assistant";
  updatedAt: string;
  unreadable: boolean;
};
export type SnapshotSummary = {
  id: number;
  name: string;
  scenarioId: number | null;
  currency: string | null;
  startMonth: string | null;
  months: number | null;
  inputsAsOf: string;
  createdAt: string;
  createdBy: "user" | "assistant";
  unreadable: boolean;
};
export type Revision = { version: number; summary: string | null; updatedBy: "user" | "assistant"; createdAt: string };

type ScenarioDetail = ScenarioSummary & { doc: ScenarioDoc | null; config: ScenarioConfig | null };

export type OpenScenario =
  | { id: "builtin"; name: string; saved: ScenarioConfig }
  | { id: number; name: string; kind: "base" | "variant"; version: number; parent: ScenarioParent | null; parentConfig: ScenarioConfig | null; saved: ScenarioConfig; updatedBy: "user" | "assistant" };

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = res.status === 423 ? "Your session is locked. Sign in again to save." : (body?.error as string) ?? "Something went wrong.";
      return { ok: false, error: msg, status: res.status };
    }
    return { ok: true, data: (body?.data ?? body) as T };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection.", status: 0 };
  }
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export function useForecastScenarios(defaultConfig: ScenarioConfig | null) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [open, setOpen] = useState<OpenScenario | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshLists = useCallback(async () => {
    const [s, n] = await Promise.all([
      call<{ scenarios: ScenarioSummary[] }>("/api/forecast/scenarios"),
      call<{ snapshots: SnapshotSummary[] }>("/api/forecast/snapshots"),
    ]);
    if (s.ok) setScenarios(s.data.scenarios);
    if (n.ok) setSnapshots(n.data.snapshots);
  }, []);

  useEffect(() => {
    void refreshLists();
  }, [refreshLists]);

  useEffect(() => {
    if (defaultConfig && !open) setOpen({ id: "builtin", name: "Baseline", saved: defaultConfig });
  }, [defaultConfig, open]);

  const parentConfigOf = useCallback(async (parent: ScenarioParent | null): Promise<ScenarioConfig | null> => {
    if (!parent) return null;
    if (parent.type === "builtin") return baselineScenario();
    const r = await call<{ scenario: ScenarioDetail }>(`/api/forecast/scenarios/${parent.id}`);
    return r.ok ? r.data.scenario.config : null;
  }, []);

  /** Open a saved scenario (or the built-in Baseline). Returns its full config for the editor. */
  const openScenario = useCallback(async (id: number | "builtin"): Promise<{ config: ScenarioConfig } | { error: string }> => {
    if (id === "builtin") {
      const cfg = defaultConfig ?? baselineScenario();
      setOpen({ id: "builtin", name: "Baseline", saved: cfg });
      return { config: cfg };
    }
    const r = await call<{ scenario: ScenarioDetail }>(`/api/forecast/scenarios/${id}`);
    if (!r.ok) return { error: r.error };
    const s = r.data.scenario;
    if (!s.config) return { error: "This scenario can't be read with your current key." };
    const parentConfig = s.kind === "variant" ? await parentConfigOf(s.parent) : null;
    setOpen({ id: s.id, name: s.name, kind: s.kind, version: s.version, parent: s.parent, parentConfig, saved: s.config, updatedBy: s.updatedBy });
    return { config: s.config };
  }, [defaultConfig, parentConfigOf]);

  const docFor = (o: Extract<OpenScenario, { id: number }>, working: ScenarioConfig): ScenarioDoc =>
    o.kind === "variant" && o.parent
      ? { kind: "variant", parent: o.parent, patch: diffFromParent(o.parentConfig ?? baselineScenario(), working) }
      : { kind: "base", config: working };

  /** Save changes to the open saved scenario. */
  const save = useCallback(async (working: ScenarioConfig, summary?: string) => {
    if (!open || open.id === "builtin") return { error: "Save it as a new scenario first." };
    setBusy(true);
    const r = await call<{ scenario: ScenarioDetail }>(`/api/forecast/scenarios/${open.id}`, json("PUT", { doc: docFor(open, working), expectedVersion: open.version, summary }));
    setBusy(false);
    if (!r.ok) return { error: r.status === 409 ? `${r.error}` : r.error };
    setOpen({ ...open, version: r.data.scenario.version, saved: r.data.scenario.config ?? working, updatedBy: "user" });
    void refreshLists();
    return { ok: true as const };
  }, [open, refreshLists]);

  /** Save the edited settings as a new scenario: a full copy, or a variant of what is open. */
  const saveAs = useCallback(async (name: string, working: ScenarioConfig, asVariant: boolean) => {
    if (!open) return { error: "Nothing open." };
    let doc: ScenarioDoc;
    if (asVariant) {
      const parent: ScenarioParent = open.id === "builtin" ? { type: "builtin" } : { type: "scenario", id: open.id };
      doc = { kind: "variant", parent, patch: diffFromParent(open.saved, working) };
    } else {
      doc = { kind: "base", config: working };
    }
    setBusy(true);
    const r = await call<{ scenario: ScenarioDetail }>("/api/forecast/scenarios", json("POST", { name, doc }));
    setBusy(false);
    if (!r.ok) return { error: r.error };
    await refreshLists();
    await openScenario(r.data.scenario.id);
    return { ok: true as const };
  }, [open, refreshLists, openScenario]);

  const rename = useCallback(async (name: string) => {
    if (!open || open.id === "builtin") return { error: "The Baseline can't be renamed." };
    const r = await call<{ scenario: ScenarioDetail }>(`/api/forecast/scenarios/${open.id}`, json("PUT", { name, expectedVersion: open.version, summary: "Renamed" }));
    if (!r.ok) return { error: r.error };
    setOpen({ ...open, name: r.data.scenario.name, version: r.data.scenario.version });
    void refreshLists();
    return { ok: true as const };
  }, [open, refreshLists]);

  /** Turn the open variant into a full scenario (no longer follows its parent). */
  const detach = useCallback(async (working: ScenarioConfig) => {
    if (!open || open.id === "builtin" || open.kind !== "variant") return { error: "Only a variant can be detached." };
    const r = await call<{ scenario: ScenarioDetail }>(`/api/forecast/scenarios/${open.id}`, json("PUT", { doc: { kind: "base", config: working }, expectedVersion: open.version, summary: "Detached from its parent" }));
    if (!r.ok) return { error: r.error };
    await openScenario(open.id);
    void refreshLists();
    return { ok: true as const };
  }, [open, openScenario, refreshLists]);

  const remove = useCallback(async () => {
    if (!open || open.id === "builtin") return { error: "The Baseline can't be deleted." };
    const r = await call(`/api/forecast/scenarios/${open.id}`, { method: "DELETE" });
    if (!r.ok) return { error: r.error };
    await refreshLists();
    await openScenario("builtin");
    return { ok: true as const };
  }, [open, refreshLists, openScenario]);

  const loadRevisions = useCallback(async (): Promise<Revision[]> => {
    if (!open || open.id === "builtin") return [];
    const r = await call<{ revisions: Revision[] }>(`/api/forecast/scenarios/${open.id}/revisions`);
    return r.ok ? r.data.revisions : [];
  }, [open]);

  const revert = useCallback(async (toVersion: number) => {
    if (!open || open.id === "builtin") return { error: "Nothing to put back." };
    const r = await call(`/api/forecast/scenarios/${open.id}/revisions`, json("POST", { toVersion, expectedVersion: open.version }));
    if (!r.ok) return { error: r.error };
    const opened = await openScenario(open.id);
    void refreshLists();
    return "config" in opened ? { ok: true as const, config: opened.config } : { error: opened.error };
  }, [open, openScenario, refreshLists]);

  const freeze = useCallback(async (name: string, result: ForecastResult, working: ScenarioConfig) => {
    const r = await call("/api/forecast/snapshots", json("POST", { name, result, config: working, scenarioId: open && open.id !== "builtin" ? open.id : null }));
    if (!r.ok) return { error: r.error };
    void refreshLists();
    return { ok: true as const };
  }, [open, refreshLists]);

  const deleteSnapshot = useCallback(async (id: number) => {
    const r = await call(`/api/forecast/snapshots/${id}`, { method: "DELETE" });
    if (!r.ok) return { error: r.error };
    void refreshLists();
    return { ok: true as const };
  }, [refreshLists]);

  /** A saved scenario's full config (for comparing), or the Baseline. */
  const configOf = useCallback(async (id: number | "builtin", horizonMonths: number): Promise<ScenarioConfig | null> => {
    if (id === "builtin") return baselineScenario(horizonMonths);
    const r = await call<{ scenario: ScenarioDetail }>(`/api/forecast/scenarios/${id}`);
    return r.ok ? r.data.scenario.config : null;
  }, []);

  const snapshotResult = useCallback(async (id: number): Promise<ForecastResult | null> => {
    const r = await call<{ snapshot: { result: ForecastResult | null } }>(`/api/forecast/snapshots/${id}`);
    return r.ok ? r.data.snapshot.result : null;
  }, []);

  return {
    scenarios, snapshots, open, busy,
    openScenario, save, saveAs, rename, detach, remove, loadRevisions, revert, freeze, deleteSnapshot, configOf, snapshotResult,
  };
}
