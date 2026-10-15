// Email imports — pure helpers for the Email imports screens (2026-10-15).
// Mirrors the web's Email tab (pf-app src/components/inbox/inbox-email-tab.tsx)
// and staged-import review; keep the rules in step with it.
import type {
  EmailCandidate,
  EmailInboxItem,
  EmailRecordBody,
  StagedImportSummary,
} from "../../../shared/types";

/** Emails waiting for a click: a parsed bank-alert body still under review. */
export function emailsToRecord(items: EmailInboxItem[]): EmailInboxItem[] {
  return items.filter((i) => i.action === "needs_review" && i.sourceKind === "body" && i.candidate != null);
}

export interface EmailRecordForm {
  accountId: number | null;
  /** "category" books it in a category; "transfer" books a transfer pair. */
  mode: "category" | "transfer";
  categoryId: number | null;
  destAccountId: number | null;
  amount: string;
  date: string;
  payee: string;
}

/** The form an email opens with: the parsed values, nothing picked yet. */
export function emailFormInit(candidate: EmailCandidate): EmailRecordForm {
  return {
    accountId: null,
    mode: "category",
    categoryId: null,
    destAccountId: null,
    amount: String(candidate.amount),
    date: candidate.date,
    payee: candidate.payee,
  };
}

/** The typed amount, a decimal comma accepted ("12,5"), as elsewhere in the app. */
export function parseAmountInput(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** "-12.5" ⇄ "12.5": money out is negative, money in positive. */
export function flipAmountSign(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  return t.startsWith("-") ? t.slice(1) : `-${t}`;
}

/**
 * The PATCH body for "Record". Like the web tab it sends amount / date / payee
 * only when they differ from what was parsed, so an untouched email records
 * exactly what the server read. Returns an error message instead when the form
 * is not complete.
 */
export function buildEmailRecordBody(
  candidate: EmailCandidate,
  form: EmailRecordForm,
  opts: { force?: boolean } = {},
): { ok: true; body: EmailRecordBody } | { ok: false; error: string } {
  if (form.accountId == null) return { ok: false, error: "Choose the account it was paid from or into" };
  const body: EmailRecordBody = { action: "record", accountId: form.accountId };
  if (form.mode === "transfer") {
    if (form.destAccountId == null) return { ok: false, error: "Choose the account it was transferred to" };
    if (form.destAccountId === form.accountId) return { ok: false, error: "A transfer needs two different accounts" };
    body.transferDestAccountId = form.destAccountId;
  } else {
    if (form.categoryId == null) return { ok: false, error: "Choose a category" };
    body.categoryId = form.categoryId;
  }
  const amount = parseAmountInput(form.amount);
  if (amount == null || amount === 0) return { ok: false, error: "Enter the amount" };
  if (amount !== candidate.amount) body.amount = amount;
  if (form.date && form.date !== candidate.date) body.date = form.date;
  const payee = form.payee.trim();
  if (payee && payee !== candidate.payee) body.payee = payee;
  if (opts.force) body.force = true;
  return { ok: true, body };
}

/** Where a staged file came from, for its row on the list. */
export function stagedSourceLabel(s: Pick<StagedImportSummary, "source">): string {
  if (s.source === "email") return "Emailed file";
  if (s.source === "connector") return "Bank feed";
  return "Uploaded file";
}

/** A staged file's title: its email subject, else the file name. */
export function stagedTitle(s: Pick<StagedImportSummary, "subject" | "originalFilename">): string {
  return s.subject?.trim() || s.originalFilename?.trim() || "Imported file";
}

/** What "Send to ledger" did, in one sentence. */
export function describeApproveResult(r: {
  approved: number;
  skippedDuplicates: number;
  rowErrors: { rowIndex: number; message: string }[];
}): string {
  const parts = [`${r.approved} ${r.approved === 1 ? "transaction" : "transactions"} sent to the account.`];
  if (r.skippedDuplicates > 0) {
    parts.push(`${r.skippedDuplicates} already there, skipped.`);
  }
  if (r.rowErrors.length > 0) {
    parts.push(
      `${r.rowErrors.length} could not be sent: ${r.rowErrors
        .slice(0, 3)
        .map((e) => `row ${e.rowIndex + 1}, ${e.message}`)
        .join("; ")}${r.rowErrors.length > 3 ? "; …" : ""}`,
    );
  }
  return parts.join(" ");
}
