/**
 * MCP HTTP tool group: loans (FINLYNQ-109 extraction).
 *
 * Handler bodies moved VERBATIM out of register-tools-pg.ts. The only edits
 * are the enclosing function wrapper + the shared-state destructure from ctx.
 * Do not reformat or re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  text,
  err,
  decryptNameish,
  resolveEntity,
  resolveOrReport,
  type Row,
  type PgToolContext,
} from "./_shared";
import {
  sql,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  decryptField,
} from "../../src/lib/crypto/envelope";
import {
  encryptName,
} from "../../src/lib/crypto/encrypted-columns";
import {
  buildLoanSchedule,
  calculateDebtPayoff,
  LoanValidationError,
  PAYMENT_FREQUENCIES,
  type Debt,
} from "../../src/lib/loan-calculator";
import {
  resolveReportingCurrency,
} from "../reporting-currency";
import {
  getRateMap,
  convertWithRateMap,
} from "../../src/lib/fx-service";
import { pickRecordCurrency } from "../../src/lib/fx/record-currency";
import {
  ymdDate,
  parseYmdSafe,
} from "../lib/date-validators";
import { registerManageTool } from "./_consolidate";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function registerLoansTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek, encNote, decNote } = ctx;


  // ═══════════════════════════════════════════════════════════════════════════
  // Wave 1B — Loans, FX, Subscriptions CRUD, Rules CRUD, Suggest, Splits CRUD
  // FINLYNQ-263 phase 2 — list/add/update/delete_loan folded into manage_loans
  // (op discriminator). Bodies lifted VERBATIM; old names stay hidden aliases.
  // get_loan_amortization + get_debt_payoff_plan stay 1:1 (heavy reads).
  // ═══════════════════════════════════════════════════════════════════════════

  // ── op: list — lifted VERBATIM from list_loans ─────────────────────────────
  async function opList(): Promise<ToolResult> {
      // Stream D Phase 4: l.name + a.name dropped — read *_ct only.
      const rawRows = await q(db, sql`
        SELECT l.id, l.name_ct, l.type, l.principal, l.annual_rate, l.term_months,
               l.start_date, l.payment_amount, l.payment_frequency, l.extra_payment,
               l.residual_value, l.note, l.account_id, l.currency,
               a.name_ct AS account_name_ct
        FROM loans l
        LEFT JOIN accounts a ON a.id = l.account_id
        WHERE l.user_id = ${userId}
        ORDER BY l.start_date DESC, l.id
      `);
      const rows: Row[] = rawRows.map((r) => ({
        ...r,
        name: r.name_ct && dek ? decryptField(dek, r.name_ct) : null,
        account_name: r.account_name_ct && dek ? decryptField(dek, r.account_name_ct) : null,
        // Free-text note is user-DEK encrypted at rest (2026-06-01).
        note: decNote(r.note as string | null),
      }));
      // FINLYNQ-136: account-linked balances — outstanding = |SUM(amount)| of
      // the linked account's ledger when it has activity (liability accounts
      // carry negative balances).
      const linkedIds = [...new Set(rows.map((r) => r.account_id).filter((x) => x != null).map(Number))];
      const acctBalances = new Map<number, { balance: number; txCount: number }>();
      if (linkedIds.length) {
        const balRows = await q(db, sql`
          SELECT account_id, COALESCE(SUM(amount), 0) AS balance, COUNT(*) AS tx_count
          FROM transactions
          WHERE user_id = ${userId} AND account_id IN (${sql.join(linkedIds.map((id) => sql`${id}`), sql`, `)})
          GROUP BY account_id
        `);
        for (const b of balRows) {
          acctBalances.set(Number(b.account_id), { balance: Number(b.balance), txCount: Number(b.tx_count) });
        }
      }
      // FINLYNQ-123 dual basis: amounts stay in each loan's own currency and
      // each row also carries a current-rate conversion, so an assistant can
      // both quote a loan correctly and total a mixed-currency book.
      const reporting = await resolveReportingCurrency(db, userId, null);
      const rateMap = await getRateMap(reporting, userId);
      const today = new Date().toISOString().split("T")[0];
      const enriched = rows.map((r) => {
        const loanCurrency = String(r.currency ?? reporting).toUpperCase();
        const toReporting = (amount: number | null) =>
          amount == null ? null : Math.round(convertWithRateMap(amount, loanCurrency, rateMap) * 100) / 100;
        const integrityRow = (error: string, value: unknown) => ({
          ...r,
          currency: loanCurrency,
          reportingCurrency: reporting,
          remainingBalanceReporting: null,
          monthlyEquivalentPaymentReporting: null,
          monthlyPayment: null,
          totalInterest: null,
          payoffDate: null,
          remainingBalance: null,
          principalPaid: null,
          interestPaid: null,
          periodsRemaining: null,
          balanceSource: null,
          dataIntegrity: { error, value },
        });
        // Issue #213 — guard against pre-validator legacy bad rows. One bad
        // start_date previously poisoned the whole list with
        // `RangeError: Invalid time value`. Surface it per row instead.
        if (parseYmdSafe(String(r.start_date)) === null) {
          return integrityRow("invalid start_date", r.start_date);
        }
        let summary;
        try {
          summary = buildLoanSchedule({
            principal: Number(r.principal),
            annualRate: Number(r.annual_rate),
            termMonths: r.term_months == null ? null : Number(r.term_months),
            startDate: String(r.start_date),
            paymentAmount: r.payment_amount == null ? null : Number(r.payment_amount),
            paymentFrequency: String(r.payment_frequency ?? "monthly"),
            extraPayment: Number(r.extra_payment ?? 0),
            residualValue: r.residual_value == null ? null : Number(r.residual_value),
          });
        } catch (e) {
          if (e instanceof LoanValidationError) return integrityRow(e.message, null);
          throw e;
        }
        const paid = summary.schedule.filter((x) => x.date <= today);
        const principalPaid = paid.reduce((s, x) => s + x.principal, 0);
        const interestPaid = paid.reduce((s, x) => s + x.interest, 0);

        let remainingBalance = Math.max(Number(r.principal) - principalPaid, 0);
        let balanceSource: "account" | "projection" = "projection";
        let payoffDate = summary.payoffDate;
        let periodsRemaining = summary.schedule.length - paid.length;
        const acct = r.account_id != null ? acctBalances.get(Number(r.account_id)) : undefined;
        if (acct && acct.txCount > 0) {
          remainingBalance = Math.round(Math.abs(acct.balance) * 100) / 100;
          balanceSource = "account";
          const residual = Number(r.residual_value ?? 0);
          if (remainingBalance <= residual + 0.01) {
            payoffDate = today;
            periodsRemaining = 0;
          } else {
            try {
              const anchored = buildLoanSchedule({
                principal: remainingBalance,
                annualRate: Number(r.annual_rate),
                startDate: today,
                paymentAmount: Number(r.payment_amount ?? summary.paymentPerPeriod),
                paymentFrequency: String(r.payment_frequency ?? "monthly"),
                extraPayment: Number(r.extra_payment ?? 0),
                residualValue: r.residual_value == null ? null : Number(r.residual_value),
              });
              payoffDate = anchored.payoffDate;
              periodsRemaining = anchored.schedule.length;
            } catch {
              // Payment doesn't amortize the actual balance — keep projection dates.
            }
          }
        }
        return {
          ...r,
          monthlyPayment: summary.monthlyPayment,
          paymentPerPeriod: summary.paymentPerPeriod,
          monthlyEquivalentPayment: summary.monthlyEquivalentPayment,
          totalInterest: summary.totalInterest,
          payoffDate,
          remainingBalance,
          balanceSource,
          principalPaid:
            balanceSource === "account"
              ? Math.round(Math.max(Number(r.principal) - remainingBalance, 0) * 100) / 100
              : Math.round(principalPaid * 100) / 100,
          interestPaid: Math.round(interestPaid * 100) / 100,
          periodsRemaining,
          currency: loanCurrency,
          reportingCurrency: reporting,
          remainingBalanceReporting: toReporting(remainingBalance),
          monthlyEquivalentPaymentReporting: toReporting(summary.monthlyEquivalentPayment),
        };
      });
      return text({ success: true, data: enriched });
  }

  // ── op: add — lifted VERBATIM from add_loan ────────────────────────────────
  async function opAdd(args: {
    name: string;
    type: string;
    principal: number;
    annual_rate: number;
    term_months?: number;
    start_date: string;
    account?: string;
    account_id?: number;
    payment_amount?: number;
    payment_frequency?: (typeof PAYMENT_FREQUENCIES)[number];
    extra_payment?: number;
    residual_value?: number;
    min_payment?: number;
    currency?: string;
    note?: string;
  }): Promise<ToolResult> {
      const { name, type, principal, annual_rate, term_months, start_date, account, account_id, payment_amount, payment_frequency, extra_payment, residual_value, min_payment, currency, note } = args;
      // FINLYNQ-267: resolve the optional linked account via the shared envelope
      // — a mistyped/unmatched name is REFUSED (not silently unlinked) and a 2+
      // match returns an ambiguous list; `account_id` is the FK fast-path.
      let accountId: number | null = null;
      if (account_id != null || account) {
        const rawAccounts = await q(db, sql`
          SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const out = resolveOrReport(
          "account",
          resolveEntity({ entity: "account", id: account_id, name: account, options: allAccounts }),
        );
        if ("report" in out) return out.report;
        accountId = out.id;
      }
      const pmt = payment_amount ?? min_payment ?? null;
      // FINLYNQ-136: refuse non-amortizing inputs (no term AND no payment,
      // payment below period interest, residual >= principal) with a clear error.
      try {
        buildLoanSchedule({
          principal,
          annualRate: annual_rate,
          termMonths: term_months ?? null,
          startDate: start_date,
          paymentAmount: pmt,
          paymentFrequency: payment_frequency ?? "monthly",
          extraPayment: extra_payment ?? 0,
          residualValue: residual_value ?? null,
        });
      } catch (e) {
        if (e instanceof LoanValidationError) return err(e.message);
        throw e;
      }
      // Currency resolution (feedback #7): explicit > linked account > display.
      // This INSERT used to omit the column entirely, so every MCP-created loan
      // silently took the table default — which was CAD.
      let accountCurrency: string | null = null;
      if (accountId != null) {
        const acctRow = await q(db, sql`
          SELECT currency FROM accounts WHERE id = ${accountId} AND user_id = ${userId}
        `);
        accountCurrency = (acctRow[0]?.currency as string | undefined) ?? null;
      }
      const loanCurrency = pickRecordCurrency({
        explicit: currency,
        accountCurrency,
        displayCurrency: await resolveReportingCurrency(db, userId, null),
      });
      const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      // Stream D Phase 4 — plaintext name dropped.
      const result = await q(db, sql`
        INSERT INTO loans (user_id, type, account_id, currency, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment, residual_value, note, name_ct, name_lookup)
        VALUES (${userId}, ${type}, ${accountId}, ${loanCurrency}, ${principal}, ${annual_rate}, ${term_months ?? null}, ${start_date}, ${pmt}, ${payment_frequency ?? "monthly"}, ${extra_payment ?? 0}, ${residual_value ?? null}, ${encNote(note)}, ${n.ct}, ${n.lookup})
        RETURNING id
      `);
      const termDesc = term_months != null ? `over ${term_months} months` : `at ${pmt}/${payment_frequency ?? "monthly"} (payment-driven)`;
      // Report the currency rather than a bare `$` — the amount is not USD.
      return text({ success: true, data: { id: result[0]?.id, currency: loanCurrency, message: `Loan "${name}" created — ${principal} ${loanCurrency} at ${annual_rate}% ${termDesc}` } });
  }

  // ── op: update — lifted VERBATIM from update_loan ──────────────────────────
  async function opUpdate(args: {
    id: number;
    name?: string;
    type?: string;
    principal?: number;
    annual_rate?: number;
    term_months?: number;
    start_date?: string;
    payment_amount?: number;
    payment_frequency?: (typeof PAYMENT_FREQUENCIES)[number];
    extra_payment?: number;
    residual_value?: number;
    account?: string;
    account_id?: number;
    currency?: string;
    note?: string;
  }): Promise<ToolResult> {
      const { id, name, type, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment, residual_value, account, account_id, currency, note } = args;
      const existing = await q(db, sql`
        SELECT id, principal, annual_rate, term_months, start_date, payment_amount,
               payment_frequency, extra_payment, residual_value
        FROM loans WHERE id = ${id} AND user_id = ${userId}
      `);
      if (!existing.length) return err(`Loan #${id} not found`);
      // FINLYNQ-136: validate the MERGED row still amortizes (e.g. lowering the
      // payment below the period interest, or raising residual past principal).
      const cur = existing[0];
      const merged = {
        principal: principal ?? Number(cur.principal),
        annualRate: annual_rate ?? Number(cur.annual_rate),
        termMonths: term_months ?? (cur.term_months == null ? null : Number(cur.term_months)),
        startDate: start_date ?? String(cur.start_date),
        paymentAmount: payment_amount ?? (cur.payment_amount == null ? null : Number(cur.payment_amount)),
        paymentFrequency: payment_frequency ?? String(cur.payment_frequency ?? "monthly"),
        extraPayment: extra_payment ?? Number(cur.extra_payment ?? 0),
        residualValue: residual_value ?? (cur.residual_value == null ? null : Number(cur.residual_value)),
      };
      if (parseYmdSafe(merged.startDate) !== null) {
        try {
          buildLoanSchedule(merged);
        } catch (e) {
          if (e instanceof LoanValidationError) return err(e.message);
          throw e;
        }
      }

      // FINLYNQ-267: `account_id` FK fast-path wins; a name resolves via the
      // shared envelope (mistyped → refuse, 2+ → ambiguous). Empty NAME clears.
      let accountIdUpdate: number | null | undefined;
      if (account_id != null) {
        const rawAccounts = await q(db, sql`
          SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const out = resolveOrReport("account", resolveEntity({ entity: "account", id: account_id, options: allAccounts }));
        if ("report" in out) return out.report;
        accountIdUpdate = out.id;
      } else if (account !== undefined) {
        if (account === "") {
          accountIdUpdate = null;
        } else {
          const rawAccounts = await q(db, sql`
            SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
          `);
          const allAccounts = decryptNameish(rawAccounts, dek);
          const out = resolveOrReport("account", resolveEntity({ entity: "account", name: account, options: allAccounts }));
          if ("report" in out) return out.report;
          accountIdUpdate = out.id;
        }
      }

      // Stream D Phase 4 — plaintext name dropped.
      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) {
        if (!dek) return err("Cannot rename loan without an unlocked DEK (Stream D Phase 4).");
        const n = encryptName(dek, name);
        updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
      }
      if (type !== undefined) updates.push(sql`type = ${type}`);
      if (principal !== undefined) updates.push(sql`principal = ${principal}`);
      if (annual_rate !== undefined) updates.push(sql`annual_rate = ${annual_rate}`);
      if (term_months !== undefined) updates.push(sql`term_months = ${term_months}`);
      if (start_date !== undefined) updates.push(sql`start_date = ${start_date}`);
      if (payment_amount !== undefined) updates.push(sql`payment_amount = ${payment_amount}`);
      if (payment_frequency !== undefined) updates.push(sql`payment_frequency = ${payment_frequency}`);
      if (extra_payment !== undefined) updates.push(sql`extra_payment = ${extra_payment}`);
      if (residual_value !== undefined) updates.push(sql`residual_value = ${residual_value}`);
      if (accountIdUpdate !== undefined) updates.push(sql`account_id = ${accountIdUpdate}`);
      // Re-denominates the loan; it does NOT convert the stored amounts. This
      // is the repair path for a loan created before the currency was settable.
      if (currency !== undefined) updates.push(sql`currency = ${currency.toUpperCase()}`);
      if (note !== undefined) updates.push(sql`note = ${encNote(note)}`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE loans SET ${sql.join(updates, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Loan #${id} updated (${updates.length} field(s))` } });
  }

  // ── op: delete — lifted VERBATIM from delete_loan ──────────────────────────
  async function opDelete(args: { id: number }): Promise<ToolResult> {
      const { id } = args;
      // Issue #211 (Bug b): SELECT returns `name_ct` (encrypted) but the
      // success message referenced `existing[0].name` — undefined post
      // Stream D Phase 4. Decrypt BEFORE the DELETE so the message is
      // informative; falls back to "#id" when DEK is absent.
      const existing = await q(db, sql`SELECT id, name_ct FROM loans WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Loan #${id} not found`);
      const decrypted = decryptNameish(existing, dek);
      const loanName = String(decrypted[0]?.name ?? "").trim();
      await db.execute(sql`DELETE FROM loans WHERE id = ${id} AND user_id = ${userId}`);
      return text({
        success: true,
        data: {
          id,
          message: loanName ? `Loan "${loanName}" deleted` : `Loan #${id} deleted`,
        },
      });
  }

  // ── consolidated tool: manage_loans ───────────
  registerManageTool(
    server,
    "manage_loans",
    "Manage loans & debt: `op` selects add / update / delete / list. add: create a loan or lease (principal/rate + term_months OR payment_amount; residual_value for leases; `currency` defaults to the linked account's, else the user's display currency). update: change any loan field by id. delete: remove a loan by id. list: all loans with balance/rate/payment/payoff date/linked account — amounts are in each loan's own `currency`, with `*Reporting` companions converted to `reportingCurrency` for totalling across currencies. For amortization schedules or payoff strategies use get_loan_amortization / get_debt_payoff_plan.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("add"),
        name: z.string().describe("Loan name"),
        type: z.string().describe("Loan type (e.g. 'mortgage', 'lease', 'auto', 'student', 'personal')"),
        principal: z.number().positive().describe("Original loan principal (must be > 0)"),
        annual_rate: z.number().nonnegative().describe("Annual interest rate, e.g. 5.5 for 5.5% (must be >= 0; zero allowed for 0% promo)"),
        term_months: z.number().int().positive().optional().describe("Loan term in months (optional when payment_amount is given — the term is solved from the payment)"),
        start_date: ymdDate.describe("Loan start date (YYYY-MM-DD)"),
        account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias). A mistyped/unmatched name is REFUSED (never silently unlinked). When linked, the account's ledger balance drives the outstanding balance."),
        account_id: z.number().int().positive().optional().describe("Linked-account FK fast-path — wins over the fuzzy `account` name."),
        payment_amount: z.number().positive().optional().describe("Payment per period (must be > 0). Must exceed the period interest or the call is refused."),
        payment_frequency: z.enum(PAYMENT_FREQUENCIES).optional().describe("weekly | biweekly | semi_monthly | monthly | quarterly | annual (default monthly)"),
        extra_payment: z.number().nonnegative().optional().describe("Extra principal per payment (must be >= 0; default 0)"),
        residual_value: z.number().nonnegative().optional().describe("Lease residual/buyout — the schedule amortizes down to this instead of 0 (must be < principal)"),
        min_payment: z.number().positive().optional().describe("Alias for payment_amount — minimum required payment (must be > 0)"),
        currency: z.string().regex(/^[A-Za-z]{3,4}$/).optional().describe("ISO code the loan is denominated in, e.g. 'RUB'. Defaults to the linked account's currency, else the user's display currency — never a hardcoded default."),
        note: z.string().optional(),
      }),
      z.object({
        op: z.literal("update"),
        id: z.number().describe("Loan id"),
        name: z.string().optional(),
        type: z.string().optional(),
        principal: z.number().positive().optional().describe("Original loan principal (must be > 0)"),
        annual_rate: z.number().nonnegative().optional().describe("Annual interest rate, e.g. 5.5 for 5.5% (must be >= 0)"),
        term_months: z.number().int().positive().optional(),
        start_date: ymdDate.optional(),
        payment_amount: z.number().positive().optional().describe("Payment per period (must be > 0; must exceed the period interest)"),
        payment_frequency: z.enum(PAYMENT_FREQUENCIES).optional().describe("weekly | biweekly | semi_monthly | monthly | quarterly | annual"),
        extra_payment: z.number().nonnegative().optional().describe("Extra principal per payment (must be >= 0)"),
        residual_value: z.number().nonnegative().optional().describe("Lease residual/buyout — balance remaining at term end (must be < principal)"),
        account: z.string().optional().describe("Linked account — name or alias (fuzzy matched — mistyped/unmatched is REFUSED; 2+ → ambiguous). Pass empty string to clear. PREFER `account_id`."),
        account_id: z.number().int().positive().optional().describe("Linked-account FK fast-path — wins over the fuzzy `account` name."),
        currency: z.string().regex(/^[A-Za-z]{3,4}$/).optional().describe("ISO code the loan is denominated in. Changes the currency the stored amounts are interpreted in — it does NOT convert them."),
        note: z.string().optional(),
      }),
      z.object({
        op: z.literal("delete"),
        id: z.number().describe("Loan id to delete"),
      }),
      z.object({
        op: z.literal("list").describe("List all loans with balance/payment/payoff."),
      }),
    ]),
    async (input) => {
      switch (input.op) {
        case "add":
          return opAdd(input);
        case "update":
          return opUpdate(input);
        case "delete":
          return opDelete(input);
        case "list":
          return opList();
      }
    },
  );



  // ── get_loan_amortization ─────────────────────────────────────────────────
  server.tool(
    "get_loan_amortization",
    "Full amortization schedule for a loan. Returns every payment period with principal/interest/balance. Amounts are in the loan's own currency; the response includes both the loan currency and the resolved reportingCurrency for context.",
    {
      loan_id: z.number().describe("Loan id"),
      as_of_date: ymdDate.optional().describe("YYYY-MM-DD — summarises paid-to-date at this point (default: today)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Surfaced in the response for cross-currency context."),
    },
    async ({ loan_id, as_of_date, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      // Stream D Phase 4: l.name dropped — read l.name_ct only.
      const rows = await q(db, sql`
        SELECT id, name_ct, principal, annual_rate, term_months, start_date,
               payment_amount, payment_frequency, extra_payment, residual_value, currency
        FROM loans WHERE id = ${loan_id} AND user_id = ${userId}
      `);
      if (!rows.length) return err(`Loan #${loan_id} not found`);
      const loan = decryptNameish(rows, dek)[0];
      // Issue #213 — early-return on legacy bad rows so this tool no longer
      // throws Invalid time value when one slipped past pre-validator code paths.
      if (parseYmdSafe(String(loan.start_date)) === null) {
        return text({
          success: false,
          error: "invalid start_date",
          loanId: loan_id,
          value: loan.start_date,
        });
      }
      let summary;
      try {
        summary = buildLoanSchedule({
          principal: Number(loan.principal),
          annualRate: Number(loan.annual_rate),
          termMonths: loan.term_months == null ? null : Number(loan.term_months),
          startDate: String(loan.start_date),
          paymentAmount: loan.payment_amount == null ? null : Number(loan.payment_amount),
          paymentFrequency: String(loan.payment_frequency ?? "monthly"),
          extraPayment: Number(loan.extra_payment ?? 0),
          residualValue: loan.residual_value == null ? null : Number(loan.residual_value),
        });
      } catch (e) {
        if (e instanceof LoanValidationError) return err(e.message);
        throw e;
      }
      const cutoff = as_of_date ?? new Date().toISOString().split("T")[0];
      const paid = summary.schedule.filter((r) => r.date <= cutoff);
      const principalPaid = paid.reduce((s, r) => s + r.principal, 0);
      const interestPaid = paid.reduce((s, r) => s + r.interest, 0);
      return text({
        success: true,
        data: {
          loanId: loan_id,
          loanName: loan.name,
          // FINLYNQ-183/284: never a CAD literal. A loan predating an explicit
          // currency reads as the user's own reporting currency, not Canada's.
          loanCurrency: String(loan.currency ?? reporting).toUpperCase(),
          reportingCurrency: reporting,
          asOfDate: cutoff,
          monthlyPayment: summary.monthlyPayment,
          paymentPerPeriod: summary.paymentPerPeriod,
          monthlyEquivalentPayment: summary.monthlyEquivalentPayment,
          paymentFrequency: summary.paymentFrequency,
          totalPayments: summary.totalPayments,
          totalInterest: summary.totalInterest,
          payoffDate: summary.payoffDate,
          residualValue: summary.residualValue,
          asOfSummary: {
            periodsElapsed: paid.length,
            principalPaid: Math.round(principalPaid * 100) / 100,
            interestPaid: Math.round(interestPaid * 100) / 100,
            remainingBalance: Math.max(Number(loan.principal) - principalPaid, 0),
            periodsRemaining: summary.schedule.length - paid.length,
          },
          schedule: summary.schedule,
          // FINLYNQ-136: per-calendar-month reportable interest, day-weighted
          // across periods that straddle month boundaries.
          monthlyAccrual: summary.monthlyAccrual,
        },
      });
    }
  );


  // ── get_debt_payoff_plan ──────────────────────────────────────────────────
  server.tool(
    "get_debt_payoff_plan",
    "Compare debt payoff strategies (avalanche vs snowball) across all user loans with an optional extra monthly payment. Balances and minimum payments are converted to reportingCurrency before ranking and before the shared extra_payment budget is applied, so a mixed-currency book is compared like for like; `inputs.debts` echoes each loan's native currency and amount alongside the converted figures. extra_payment is interpreted in reportingCurrency.",
    {
      strategy: z.enum(["avalanche", "snowball", "both"]).optional().describe("'avalanche' (highest rate first), 'snowball' (smallest balance first), or 'both' (default)"),
      extra_payment: z.number().optional().describe("Extra monthly payment to apply on top of minimums (default 0)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ strategy, extra_payment, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      // Stream D Phase 4: l.name dropped — read l.name_ct only.
      const loansRaw = await q(db, sql`
        SELECT id, name_ct, principal, annual_rate, term_months, start_date,
               payment_amount, payment_frequency, extra_payment, residual_value,
               currency
        FROM loans WHERE user_id = ${userId}
      `);
      if (!loansRaw.length) return text({ success: true, data: { message: "No loans found", strategies: {} } });
      const loans = decryptNameish(loansRaw, dek);
      // FINLYNQ-123: this tool RANKS loans against each other (snowball orders
      // by balance) and pools one `extra_payment` budget across all of them, so
      // every balance and minimum must be in ONE currency first. Without this
      // an ₽8.1M loan outranked every USD debt by ~80x and consumed the whole
      // extra budget — the strategy itself came out wrong, not just its labels.
      const rateMap = await getRateMap(reporting, userId);
      const today = new Date().toISOString().split("T")[0];
      // Issue #213 — split out legacy bad rows so one bad start_date no
      // longer poisons the whole strategy computation. The bad rows still
      // surface to the caller (`excluded`) so they can be fixed.
      const excluded: Array<{ loanId: number; error: string; value: unknown }> = [];
      const debts: Debt[] = [];
      // Native-currency echo so the caller can see what each figure was before
      // conversion — the converted `debts` array is what drives the strategy.
      const debtsNative: Array<{
        id: number; name: string; currency: string;
        nativeBalance: number; nativeMinPayment: number;
        balance: number; minPayment: number;
      }> = [];
      for (const l of loans) {
        if (parseYmdSafe(String(l.start_date)) === null) {
          excluded.push({ loanId: Number(l.id), error: "invalid start_date", value: l.start_date });
          continue;
        }
        let summary;
        try {
          summary = buildLoanSchedule({
            principal: Number(l.principal),
            annualRate: Number(l.annual_rate),
            termMonths: l.term_months == null ? null : Number(l.term_months),
            startDate: String(l.start_date),
            paymentAmount: l.payment_amount == null ? null : Number(l.payment_amount),
            paymentFrequency: String(l.payment_frequency ?? "monthly"),
            extraPayment: Number(l.extra_payment ?? 0),
            residualValue: l.residual_value == null ? null : Number(l.residual_value),
          });
        } catch (e) {
          if (e instanceof LoanValidationError) {
            excluded.push({ loanId: Number(l.id), error: e.message, value: null });
            continue;
          }
          throw e;
        }
        const paid = summary.schedule.filter((r) => r.date <= today);
        const principalPaid = paid.reduce((s, r) => s + r.principal, 0);
        const nativeBalance = Math.round(Math.max(Number(l.principal) - principalPaid, 0) * 100) / 100;
        const nativeMinPayment = Number(l.payment_amount ?? summary.monthlyPayment);
        const loanCurrency = String(l.currency ?? reporting).toUpperCase();
        const balance = Math.round(convertWithRateMap(nativeBalance, loanCurrency, rateMap) * 100) / 100;
        const minPayment = Math.round(convertWithRateMap(nativeMinPayment, loanCurrency, rateMap) * 100) / 100;
        debts.push({
          id: Number(l.id),
          name: String(l.name),
          // Rate is a percentage — comparable across currencies as-is, so the
          // avalanche ordering was always sound; only snowball/pooling broke.
          balance,
          rate: Number(l.annual_rate),
          minPayment,
        });
        debtsNative.push({
          id: Number(l.id),
          name: String(l.name),
          currency: loanCurrency,
          nativeBalance,
          nativeMinPayment,
          balance,
          minPayment,
        });
      }
      const strat = strategy ?? "both";
      const extra = extra_payment ?? 0;
      const result: Record<string, unknown> = {
        // `extraPayment` is the caller's pooled budget and is interpreted in
        // the reporting currency, same as every converted balance below.
        inputs: { extraPayment: extra, extraPaymentCurrency: reporting, debts: debtsNative },
        reportingCurrency: reporting,
        amountsConvertedTo: reporting,
      };
      if (excluded.length) result.excluded = excluded;
      if (strat === "avalanche" || strat === "both") {
        result.avalanche = calculateDebtPayoff(debts, extra, "avalanche");
      }
      if (strat === "snowball" || strat === "both") {
        result.snowball = calculateDebtPayoff(debts, extra, "snowball");
      }
      return text({ success: true, data: result });
    }
  );
}
