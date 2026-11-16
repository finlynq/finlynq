/**
 * The list of Finlynq guide modules (FINLYNQ-219). Pure and client-safe.
 *
 * To add a module: create `modules/<id>.ts` exporting `guide`, then add it to
 * `GUIDE_MODULES` below. That is all: `finlynq_help(topic)`, the
 * `get_guidance` index and Settings → AI guidance all read this list.
 * `tests/guidance-modules.test.ts` fails if a file in modules/ isn't listed,
 * if an id repeats, or if a module is over the size cap.
 */

import type { GuideModule } from "./types";
import { guide as reconcile } from "./modules/reconcile";
import { guide as portfolio } from "./modules/portfolio";
import { guide as loans } from "./modules/loans";
import { guide as budgeting } from "./modules/budgeting";

export type { GuideModule } from "./types";

export const GUIDE_MODULES: readonly GuideModule[] = [reconcile, portfolio, loans, budgeting]
  .slice()
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

/** Module ids as a non-empty tuple, for `z.enum` (strict clients need a typed enum). */
export const GUIDE_MODULE_IDS = GUIDE_MODULES.map((m) => m.id) as [string, ...string[]];

export function findGuideModule(id: string): GuideModule | null {
  return GUIDE_MODULES.find((m) => m.id === id) ?? null;
}

/** The index entry for a module: everything but the body. */
export function guideModuleSummary(m: GuideModule) {
  return { id: m.id, title: m.title, summary: m.summary };
}

/** Same model-independent estimate business-finlynq uses: about 4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const GUIDE_MODULE_MAX_TOKENS = 3000;
