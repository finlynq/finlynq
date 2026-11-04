// Refreshes the widgets' snapshot while the app is open and signed in. The
// widgets themselves never reach the network and hold no credentials, so their
// figures are as of the last time this ran; they say so once they are an hour old.

import type { LoanSummary } from "../../../../shared/types";
import { endpoints, getSession } from "../../api/client";
import { logger } from "../logger";
import { localDateISO, type RecurringRow, type SubscriptionRow } from "../subscriptions";
import { hasSnapshotReaders, readSnapshot, widgetsAvailable, writeSnapshot } from "../../../modules/finlynq-widgets";
import {
  leftToSpendSection,
  loansToSchedule,
  mergeSnapshot,
  netWorthSection,
  parseSnapshot,
  upcomingSection,
  type LoanNextPayment,
} from "./snapshot";

/** Opening the app repeatedly refreshes at most this often. */
export const WIDGET_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
const LOAN_SCHEDULE_CONCURRENCY = 4;

export type WidgetSyncResult = "unavailable" | "no-widgets" | "throttled" | "locked" | "failed" | "updated";

let lastSyncAt = 0;
let inFlight: Promise<WidgetSyncResult> | null = null;
let rerunRequested = false;

/** Test seam: forget the throttle and any queued run. */
export function resetWidgetSyncForTests() {
  lastSyncAt = 0;
  inFlight = null;
  rerunRequested = false;
}

/** The next payment date needs each loan's own schedule; a loan that fails is left out. */
async function loadLoanPayments(loans: LoanSummary[]): Promise<LoanNextPayment[]> {
  const queue = loansToSchedule(loans);
  const results: LoanNextPayment[] = [];
  const worker = async () => {
    for (let loan = queue.shift(); loan; loan = queue.shift()) {
      const res = await endpoints.getLoanSchedule(loan.id);
      if (res.success && res.data) results.push({ loan, schedule: res.data.summary.schedule });
    }
  };
  await Promise.all(Array.from({ length: LOAN_SCHEDULE_CONCURRENCY }, worker));
  return results;
}

async function runSync(): Promise<WidgetSyncResult> {
  // Without the encryption key the server answers with no readable names. It
  // also runs first so a dead session cannot raise a sign-in prompt from here.
  let session;
  try {
    session = await getSession();
  } catch (e) {
    logger.warn("widgets", "session check failed", { error: e instanceof Error ? e.name : "unknown" });
    return "failed";
  }
  if (!session.authenticated || session.encryptionLocked) return "locked";

  const nowMs = Date.now();
  const today = localDateISO();
  const [budget, subs, recurring, loans, dashboard] = await Promise.all([
    endpoints.getBudgetMonth(today.slice(0, 7)),
    endpoints.getSubscriptions(),
    endpoints.getRecurring(),
    endpoints.getLoans(),
    endpoints.getDashboard(),
  ]);

  const leftToSpend = budget.success && budget.data ? leftToSpendSection(budget.data, nowMs) : null;
  // Detected series and loans add to the list; a server missing either still has one.
  const upcoming =
    subs.success && Array.isArray(subs.data)
      ? upcomingSection(
          subs.data as unknown as SubscriptionRow[],
          recurring.success && recurring.data?.recurring ? (recurring.data.recurring as unknown as RecurringRow[]) : [],
          loans.success && Array.isArray(loans.data) ? await loadLoanPayments(loans.data) : [],
          today,
          nowMs,
        )
      : null;
  const netWorth = dashboard.success && dashboard.data ? netWorthSection(dashboard.data, nowMs) : null;

  if (!leftToSpend && !upcoming && !netWorth) return "failed";
  const merged = mergeSnapshot(parseSnapshot(readSnapshot()), { leftToSpend, upcoming, netWorth }, nowMs);
  await writeSnapshot(JSON.stringify(merged));
  logger.info("widgets", "snapshot updated", {
    leftToSpend: !!leftToSpend,
    upcoming: upcoming?.items.length ?? null,
    netWorth: !!netWorth,
  });
  return "updated";
}

/**
 * Does nothing unless a widget that shows figures is on a home screen, so no
 * decrypted names are stored for someone who never added one. `force` skips the
 * throttle (the user just changed something or tapped Refresh).
 */
export async function syncWidgets(opts: { force?: boolean } = {}): Promise<WidgetSyncResult> {
  if (!widgetsAvailable) return "unavailable";
  if (!hasSnapshotReaders()) return "no-widgets";
  if (inFlight) {
    // That run may have read the data before this change: go again after it.
    if (opts.force) rerunRequested = true;
    return inFlight;
  }
  const fresh = Date.now() - lastSyncAt < WIDGET_SYNC_MIN_INTERVAL_MS;
  if (!opts.force && fresh && readSnapshot() != null) return "throttled";

  inFlight = (async () => {
    try {
      const result = await runSync();
      if (result === "updated") lastSyncAt = Date.now();
      return result;
    } catch (e) {
      logger.warn("widgets", "snapshot refresh failed", { error: e instanceof Error ? e.name : "unknown" });
      return "failed" as const;
    } finally {
      inFlight = null;
    }
  })();
  const result = await inFlight;
  if (rerunRequested) {
    rerunRequested = false;
    return syncWidgets({ force: true });
  }
  return result;
}
