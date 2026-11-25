/**
 * Variants (plan/forecast-scenarios.md section 9): a variant stores only its
 * differences from its parent, so a later change to the parent flows into it.
 * The page always edits a FULL config; saving a variant stores
 * `diffFromParent(parent, edited)`, loading it applies `applyPatch`.
 * Pure, client-safe.
 */
import {
  baselineScenario,
  scenarioConfigSchema,
  variantPatchSchema,
  type ForecastLayer,
  type ScenarioConfig,
  type ScenarioDoc,
  type VariantPatch,
} from "./config";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function applyPatch(parent: ScenarioConfig, patch: VariantPatch): ScenarioConfig {
  const removed = new Set(patch.removedLayerIds);
  let layers: ForecastLayer[] = [
    ...parent.layers.filter((l) => !removed.has(l.id)).map((l) => patch.layerOverrides[l.id] ?? l),
    ...patch.addedLayers,
  ];
  if (patch.order?.length) {
    const pos = new Map(patch.order.map((id, i) => [id, i]));
    layers = [...layers].sort((a, b) => (pos.get(a.id) ?? 1e6) - (pos.get(b.id) ?? 1e6));
  }
  const removedEvents = new Set(patch.removedEventIds ?? []);
  const events = [
    ...(parent.events ?? []).filter((e) => !removedEvents.has(e.id)).map((e) => patch.eventOverrides?.[e.id] ?? e),
    ...(patch.addedEvents ?? []),
  ];
  return scenarioConfigSchema.parse({
    ...parent,
    events,
    horizonMonths: patch.horizonMonths ?? parent.horizonMonths,
    shortfall: patch.shortfall ?? parent.shortfall,
    assumptions: { ...parent.assumptions, ...(patch.assumptions ?? {}) },
    layers,
  });
}

export function diffFromParent(parent: ScenarioConfig, edited: ScenarioConfig): VariantPatch {
  const parentById = new Map(parent.layers.map((l) => [l.id, l]));
  const editedIds = new Set(edited.layers.map((l) => l.id));
  const layerOverrides: Record<string, ForecastLayer> = {};
  const addedLayers: ForecastLayer[] = [];
  for (const l of edited.layers) {
    const p = parentById.get(l.id);
    if (!p) addedLayers.push(l);
    else if (!same(p, l)) layerOverrides[l.id] = l;
  }
  const removedLayerIds = parent.layers.filter((l) => !editedIds.has(l.id)).map((l) => l.id);
  const assumptions: Partial<ScenarioConfig["assumptions"]> = {};
  for (const k of Object.keys(edited.assumptions) as Array<keyof ScenarioConfig["assumptions"]>) {
    if (edited.assumptions[k] !== parent.assumptions[k]) assumptions[k] = edited.assumptions[k];
  }
  const parentEvents = new Map((parent.events ?? []).map((e) => [e.id, e]));
  const editedEventIds = new Set((edited.events ?? []).map((e) => e.id));
  const eventOverrides: Record<string, ScenarioConfig["events"][number]> = {};
  const addedEvents: ScenarioConfig["events"] = [];
  for (const e of edited.events ?? []) {
    const p = parentEvents.get(e.id);
    if (!p) addedEvents.push(e);
    else if (!same(p, e)) eventOverrides[e.id] = e;
  }
  const removedEventIds = (parent.events ?? []).filter((e) => !editedEventIds.has(e.id)).map((e) => e.id);
  const patch: VariantPatch = variantPatchSchema.parse({
    layerOverrides,
    removedLayerIds,
    addedLayers,
    eventOverrides,
    removedEventIds,
    addedEvents,
    ...(edited.horizonMonths !== parent.horizonMonths ? { horizonMonths: edited.horizonMonths } : {}),
    ...(edited.shortfall !== parent.shortfall ? { shortfall: edited.shortfall } : {}),
    ...(Object.keys(assumptions).length ? { assumptions } : {}),
  });
  // Keep the order only when applying the patch would not reproduce it.
  const naive = applyPatch(parent, patch).layers.map((l) => l.id);
  const wanted = edited.layers.map((l) => l.id);
  if (!same(naive, wanted)) patch.order = wanted;
  return patch;
}

/** True when a variant's patch changes nothing. */
export function isEmptyPatch(p: VariantPatch): boolean {
  return (
    !Object.keys(p.layerOverrides).length &&
    !p.removedLayerIds.length &&
    !p.addedLayers.length &&
    !Object.keys(p.eventOverrides ?? {}).length &&
    !(p.removedEventIds ?? []).length &&
    !(p.addedEvents ?? []).length &&
    p.horizonMonths == null &&
    p.shortfall == null &&
    !Object.keys(p.assumptions ?? {}).length &&
    !p.order?.length
  );
}

/**
 * Resolve a stored scenario to a full config. `lookup` returns another
 * stored scenario's doc by id (for variants of variants); cycles and missing
 * parents fall back to the built-in Baseline.
 */
export function resolveDoc(
  doc: ScenarioDoc,
  lookup: (id: number) => ScenarioDoc | null,
  seen: Set<number> = new Set(),
): ScenarioConfig {
  if (doc.kind === "base") return doc.config;
  let parent: ScenarioConfig;
  if (doc.parent.type === "builtin") parent = baselineScenario();
  else if (seen.has(doc.parent.id)) parent = baselineScenario();
  else {
    const p = lookup(doc.parent.id);
    parent = p ? resolveDoc(p, lookup, new Set([...seen, doc.parent.id])) : baselineScenario();
  }
  return applyPatch(parent, doc.patch);
}
