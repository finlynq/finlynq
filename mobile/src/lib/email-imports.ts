// Email imports — pure helpers for the Email imports screens (2026-10-15).
// Mirrors the web's Email tab (pf-app src/components/inbox/inbox-email-tab.tsx)
// and staged-import review; keep the rules in step with it.
import type {
  EmailCandidate,
  EmailInboxItem,
  EmailParseSignals,
  EmailRecordBody,
  EmailRuleHold,
  StagedImportSummary,
} from "../../../shared/types";

/**
 * Where an email stands, for the list and its To record / Recorded switch
 * (owner feedback 2026-10-15: one list of emails, not "emails" beside
 * "statement files").
 *   to_record      a bank-alert email read as one transaction, waiting for a click
 *   unreadable     no amount could be read from it: open it to read, or discard
 *   file_to_review it carried a statement file whose rows are still waiting
 *   recorded / auto_recorded / duplicate / file_done  nothing left to do
 * Discarded emails are left out.
 */
export type EmailStatus =
  | "to_record"
  | "unreadable"
  | "file_to_review"
  | "recorded"
  | "auto_recorded"
  | "duplicate"
  | "file_done";

export function emailStatus(item: EmailInboxItem, pendingStagedIds: ReadonlySet<string>): EmailStatus | null {
  if (item.action === "discarded") return null;
  if (item.action === "auto_recorded") return "auto_recorded";
  if (item.action === "manually_recorded") return "recorded";
  if (item.action === "duplicate_skipped") return "duplicate";
  if (item.sourceKind === "attachment") {
    // An attachment email keeps its action; its file decides whether work is left.
    return item.stagedImportId && pendingStagedIds.has(item.stagedImportId) ? "file_to_review" : "file_done";
  }
  return item.candidate ? "to_record" : "unreadable";
}

export function isStillToRecord(status: EmailStatus): boolean {
  return status === "to_record" || status === "unreadable" || status === "file_to_review";
}

export interface EmailListEntry {
  item: EmailInboxItem;
  status: EmailStatus;
}

/** The two halves of the switch, newest first (the server's order). */
export function splitEmails(
  items: EmailInboxItem[],
  pendingStagedIds: ReadonlySet<string>,
): { toRecord: EmailListEntry[]; recorded: EmailListEntry[] } {
  const toRecord: EmailListEntry[] = [];
  const recorded: EmailListEntry[] = [];
  for (const item of items) {
    const status = emailStatus(item, pendingStagedIds);
    if (!status) continue;
    (isStillToRecord(status) ? toRecord : recorded).push({ item, status });
  }
  return { toRecord, recorded };
}

/** A short note for an email's row. */
export function emailStatusLabel(status: EmailStatus): string {
  switch (status) {
    case "to_record":
      return "To record";
    case "unreadable":
      return "No amount found";
    case "file_to_review":
      return "Statement file";
    case "recorded":
      return "Recorded";
    case "auto_recorded":
      return "Recorded by an email rule";
    case "duplicate":
      return "Already recorded";
    default:
      return "Statement file, done";
  }
}

/**
 * The note on a "to record" row: an email rule matched it (the web tab's
 * "rule matched"), and/or the amount was read with low confidence.
 */
export function toRecordNote(item: Pick<EmailInboxItem, "action" | "matchedRuleId" | "parseConfidence">): string | null {
  const parts: string[] = [];
  if (item.action === "needs_review" && item.matchedRuleId != null) parts.push("Rule matched");
  if (item.parseConfidence === "low") parts.push(parts.length ? "check the amount" : "Check the amount");
  return parts.length ? parts.join(" · ") : null;
}

/**
 * What to say about the rule that matched a waiting email, in the web tab's
 * words (pf-app inbox-email-tab.tsx, 2026-10-16), and which one-click action
 * goes with it:
 *   duplicate    held as a possible duplicate: "Record anyway" (record_rule
 *                with force) when the rule can record, and Discard
 *   matched      the rule can record it: "Record with this rule"
 *   no_category  the rule has no category or transfer: pick one in the form
 * Unlike the web, a held email whose rule has no category gets no "Record
 * anyway": the server would refuse it (no_category).
 */
export type RuleHoldNotice =
  | { kind: "duplicate"; text: string; canForce: boolean }
  | { kind: "matched"; text: string }
  | { kind: "no_category"; text: string };

const NO_CATEGORY_TEXT = "It has no category, so it can't record on its own: pick one below.";

export function ruleHoldNotice(
  hold: EmailRuleHold,
  opts: {
    /** The account the rule records into, when the app has it. */
    account?: { name: string; currency: string } | null;
    /** The email's own currency, used when the account is unknown. */
    fallbackCurrency: string;
    money: (value: number, currency: string) => string;
  },
): RuleHoldNotice {
  const name = `“${hold.ruleName}”`;
  if (hold.duplicate) {
    const d = hold.duplicate;
    const currency = opts.account?.currency ?? opts.fallbackCurrency;
    const what = d.payee?.trim() || `transaction #${d.transactionId}`;
    const text =
      `Rule ${name} matched, but this wasn't recorded: it looks like a duplicate of ` +
      `${what} ${opts.money(d.amount, currency)} on ${d.date}` +
      `${opts.account ? ` in ${opts.account.name}` : ""}. ` +
      "Only the amount and a date within 4 days are compared, so a separate purchase of the same amount is held too." +
      (hold.canRecord ? "" : ` ${NO_CATEGORY_TEXT}`);
    return { kind: "duplicate", text, canForce: hold.canRecord };
  }
  if (!hold.canRecord) return { kind: "no_category", text: `Rule ${name} matched. ${NO_CATEGORY_TEXT}` };
  return {
    kind: "matched",
    text: `Rule ${name} matched. ${
      hold.mode === "review" ? "It's set to wait for your click." : "It wasn't recorded automatically."
    }`,
  };
}

// Why the server refused "Record with this rule" (400 `code`), in words.
const RULE_RECORD_ERRORS: Record<string, string> = {
  no_matched_rule: "The rule that matched this email is gone or turned off. Record it with the form below.",
  no_category: "The rule has no category, so pick one below.",
  account_not_found: "The rule's account no longer exists. Record it with the form below.",
  category_not_found: "The rule's category no longer exists. Pick one below.",
  investment_account: "The rule records into an investment account, which an email can't be recorded into. Pick another below.",
};

export function ruleRecordError(error: string, code?: string): string {
  if (code && RULE_RECORD_ERRORS[code]) return RULE_RECORD_ERRORS[code];
  return code ? `${error} (${code})` : error;
}

// Named entities common in bank emails; anything else is left as written.
const NAMED_ENTITIES: Record<string, string> = {
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  pound: "£",
  yen: "¥",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
};

/**
 * The email's text to read on a phone. Plain text when the email has it;
 * otherwise its HTML reduced to text that keeps the line breaks, so a table
 * of "Merchant / Amount / Date" stays readable (the web shows the HTML itself;
 * the app has no web view). Never rendered as HTML.
 */
export function emailBodyText(bodyText: string | null | undefined, bodyHtml: string | null | undefined): string {
  if (bodyText && bodyText.trim()) return bodyText.replace(/\r\n/g, "\n").trim();
  if (!bodyHtml) return "";
  const text = bodyHtml
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "  ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Why a parsed email needs a closer look, in the web tab's words
 * (pf-app inbox-email-tab.tsx "Why this needs review").
 */
export function reviewReasons(
  candidate: Pick<EmailCandidate, "payee"> | null,
  signals: EmailParseSignals | null | undefined,
  money: (value: number, currency: string) => string,
): string[] {
  if (!signals) return [];
  const reasons: string[] = [];
  if (signals.multipleAmounts) {
    reasons.push(`More than one amount in the email (${signals.detectedAmounts.map((a) => money(a.value, a.currency)).join(", ")})`);
  }
  if (signals.usedFallbackDate) reasons.push("No date in the email, so the date it arrived is used");
  if (signals.dateAmbiguous) reasons.push("The date could be day/month or month/day");
  if (!signals.signExplicit) reasons.push("It doesn't say whether money went out or came in, so it is taken as money out");
  if (candidate?.payee === "Unknown") reasons.push("No payee could be found");
  return reasons;
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
