// Bank feed (SimpleFIN) wording for BankFeedScreen. Pure, so the screen only
// renders what these return.
//
// Mobile syncs the accounts already linked on the web (POST .../sync with no
// choices). A bank account that is not linked yet comes back in
// `skippedNoChoice` and is pointed at the web, where the Create / Link choice
// lives. The problem list and its explanation mirror the web page's
// `SyncProblems` (src/app/(app)/settings/bank-feeds/page.tsx): keep in sync.
import type {
  SimplefinStagedResult,
  SimplefinStatus,
  SimplefinSyncResult,
  SimplefinSyncStatus,
} from "../../../shared/types";

export const SIMPLEFIN_BRIDGE_URL = "https://beta-bridge.simplefin.org/";

export const BANK_FEED_NOT_CONNECTED_TEXT =
  "No bank feed is connected. Connect SimpleFIN on the web app, under Settings → Bank feeds, then sync it from here.";

export const BANK_FEED_TIMING_TEXT =
  "SimpleFIN collects new transactions from your banks about once a day, so a purchase made today may not arrive until tomorrow. " +
  "Finlynq also syncs by itself when you sign in, at most every 12 hours.";

export const SYNC_PROBLEMS_HELP_TEXT =
  "Messages about a bank connection come from SimpleFIN: sign in at simplefin.org and check that bank there. " +
  "Accounts without a problem still synced.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * A sync time in the phone's local time: "today, 5:17 PM", "yesterday, 9:02 AM",
 * "Oct 28, 5:17 PM", or with the year when it is not this year. Built by hand
 * (like DateField's label) so it reads the same on every phone.
 */
export function syncTimeLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const h = d.getHours();
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, now)) return `today, ${time}`;
  if (sameDay(d, yesterday)) return `yesterday, ${time}`;
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? `${day}, ${time}` : `${day}, ${d.getFullYear()}, ${time}`;
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

/**
 * When the feed last reached the bank data: the later of the last time rows
 * were staged and the last sync that ran (fully or with problems). A sync that
 * found nothing new still counts, unlike the web page's "Last synced".
 */
export function lastSyncedAt(status: SimplefinStatus): string | null {
  const ran = status.lastSync && (status.lastSync.ok || status.lastSync.partial) ? status.lastSync.at : null;
  return later(status.lastSyncAt, ran);
}

export function lastSyncLine(status: SimplefinStatus, now: Date = new Date()): string {
  const at = lastSyncedAt(status);
  return at ? `Last synced ${syncTimeLabel(at, now)}` : "Not synced yet";
}

/** The note shown when the last sync failed or reported problems, else null. */
export function lastSyncProblemNote(
  lastSync: SimplefinSyncStatus | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!lastSync || lastSync.ok) return null;
  const which = lastSync.trigger === "auto" ? "The automatic sync" : "The last sync";
  const how = lastSync.partial ? "finished with problems" : "failed";
  const message = lastSync.message ? ` ${lastSync.message}` : "";
  const next = lastSync.partial ? "Sync now to see what they were." : "Sync now to try again.";
  return `${which} ${how} (${syncTimeLabel(lastSync.at, now)}).${message} ${next}`;
}

export function problemsHeading(count: number): string {
  return count === 1 ? "1 problem was reported during this sync" : `${count} problems were reported during this sync`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Where to go next for one account's rows. */
export type SyncTarget =
  | { screen: "StagedImport"; id: string; title: string; label: string }
  | { screen: "Inbox"; accountId: number; label: string };

export interface SyncAccountLine {
  accountId: number;
  accountName: string;
  text: string;
  target: SyncTarget | null;
}

/** What the sync did for one account, and where its new rows are waiting. */
export function syncAccountLine(s: SimplefinStagedResult): SyncAccountLine {
  const base = { accountId: s.accountId, accountName: s.accountName };
  const dupes = s.duplicateCount > 0 ? ` · ${s.duplicateCount} already in Finlynq` : "";
  const swept =
    (s.sweptStaleRows ?? 0) > 0
      ? ` · ${plural(s.sweptStaleRows ?? 0, "older row", "older rows")} recorded by your rules`
      : "";
  const reconcile: SyncTarget = { screen: "Inbox", accountId: s.accountId, label: "Reconcile" };

  if (s.newCount === 0) return { ...base, text: `Nothing new${dupes}${swept}`, target: null };

  const fresh = plural(s.newCount, "new transaction", "new transactions");
  if (s.stage === "pending") {
    return {
      ...base,
      text: `${fresh}, waiting for your review${dupes}`,
      target: { screen: "StagedImport", id: s.stagedImportId, title: s.accountName, label: "Review" },
    };
  }
  if (s.stage === "loaded") {
    return { ...base, text: `${fresh}, ready to match in Reconcile${dupes}`, target: reconcile };
  }
  // auto: the account's rules recorded what they matched; the rest wait in Reconcile.
  const left = Math.max(0, s.newCount - s.recorded);
  if (left === 0) return { ...base, text: `${fresh}, all recorded by your rules${dupes}${swept}`, target: null };
  const recorded = s.recorded > 0 ? `${s.recorded} recorded by your rules, ` : "";
  return {
    ...base,
    text: `${fresh}: ${recorded}${left} to categorize in Reconcile${dupes}${swept}`,
    target: reconcile,
  };
}

export interface SyncSummary {
  headline: string;
  accounts: SyncAccountLine[];
  /** Bank accounts with nothing imported because they are not linked yet. */
  newAccounts: string | null;
  pendingNote: string | null;
  problems: string[];
}

export function summarizeSync(result: SimplefinSyncResult): SyncSummary {
  const staged = Array.isArray(result.staged) ? result.staged : [];
  const skipped = Array.isArray(result.skippedNoChoice) ? result.skippedNoChoice : [];
  const total = staged.reduce((n, s) => n + s.newCount, 0);
  const headline =
    total > 0 ? `${plural(total, "new transaction", "new transactions")} from your bank` : "Nothing new from your bank";
  const one = skipped.length === 1;
  const newAccounts =
    skipped.length === 0
      ? null
      : `${one ? "1 bank account is" : `${skipped.length} bank accounts are`} not linked to Finlynq yet` +
        ` (${skipped.map((s) => s.name).join(", ")}), so nothing was imported from ${one ? "it" : "them"}. ` +
        `Link ${one ? "it" : "them"} on the web app, under Settings → Bank feeds, and ${one ? "it syncs" : "they sync"} from here after that.`;
  const pending = result.skippedPending ?? 0;
  const pendingNote =
    pending > 0
      ? `${plural(pending, "pending charge is", "pending charges are")} left out until the bank posts ${pending === 1 ? "it" : "them"}.`
      : null;
  return {
    headline,
    accounts: staged.map(syncAccountLine),
    newAccounts,
    pendingNote,
    problems: Array.isArray(result.errors) ? result.errors : [],
  };
}
