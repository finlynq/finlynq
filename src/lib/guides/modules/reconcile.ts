import type { GuideModule } from "../types";

export const guide: GuideModule = {
  id: "reconcile",
  title: "Reconciling a bank statement",
  summary: "Bring a statement from a file in chat to a reconciled account with a zero balance difference, in batches.",
  order: 10,
  markdown: `# Reconciling a bank statement

Finlynq is a bookkeeping ledger. It never connects to a bank. Reconciling means matching the rows of a statement the user gives you against the transactions already recorded, adding what is missing, and confirming the account's balance agrees with the statement.

All reconcile tools work over the web (HTTP) connection only and need an unlocked session.

## Start here
1. Call \`get_reconciliation_summary\`. It returns \`{ totals, accounts }\`: per account, how many bank rows are unrecorded and the difference between the ledger and the last statement balance (\`balanceDelta\`).
2. Pick the account the statement belongs to. Investment accounts are not reconciled this way: they are valued at market prices, so use the portfolio tools instead.

## 1. Load the file (one call)
Parse the CSV, OFX, QFX or PDF the user dropped into chat yourself: work out the date format, the sign convention (is money out negative?), each row's date, payee and amount, and the statement's closing balance and period. Then make ONE \`manage_statement_import(op='upload', fileContent, fileName, accountId)\` call. Never stage rows one at a time.

The upload is idempotent by content: sending the same file again while it is still pending returns \`{ stagedImportId, duplicateOf }\` and stages nothing, so a retry is safe. An unreadable file returns \`detectedFormat: 'unrecognised'\` and creates nothing.

## 2. Check for overlap first
Statements overlap at month boundaries. Run \`manage_bank_ledger(op='find_duplicates', accountId)\` before matching. Report duplicates to the user ("14 already in the ledger, skipped"); never drop them silently. \`manage_bank_ledger(op='delete_row', bankTransactionId)\` removes an extra copy (dry run first).

## 3. Match in three buckets
\`reconcile(op='suggest', accountId)\` leads with buckets:
- **Exact** (same amount, date within 3 days): safe to accept as a batch.
- **Fuzzy** (looser amount or date): show the user a short confirm/reject list. Never accept these on your own.
- **No match**: candidate new transactions. Use \`reconcile(op='apply_rules')\` for payees the user's rules know, \`suggest_transaction_details\` for new ones, and for a payee that will keep coming back, propose a rule with \`test_rule\` (a dry run) before creating it.

## 4. Commit in batches
One confirmation per batch, never per row:
- \`manage_statement_import(op='send_to_bank_ledger', stagedImportId)\` moves the file's rows into the bank ledger only (no transactions are created). Use \`op='approve'\` only for the first import of a brand-new account, which creates the transactions.
- \`reconcile(op='accept', pairs[])\` links a whole bucket of transaction↔bank-row pairs in one call.
- \`reconcile(op='apply_rules', bankRowIds)\` is two steps: a preview returns a confirmation token; send it back with \`autoMaterialize: true\`.
A 200-row statement should take about 3 confirmations, not 200.

## 5. Anchor and verify
Record the statement's closing balance with \`manage_bank_ledger(op='upsert_anchor', accountId, date, amount, currency)\`, then call \`get_reconciliation_summary\` again. The account's \`balanceDelta\` must be 0. If it isn't, you are not done: look again with \`reconcile(op='suggest')\` and name the rows that explain the gap (pending items, fees). Finish with: matched / created / duplicates skipped / flagged for the user / difference.

## Fields you will see
- \`seenCount\`: how many times the SAME bank row was imported again. It is not a sign of duplicates. Real duplicates are two different rows (different ids) for one event, found by \`find_duplicates\`.
- \`importHash\`: a fingerprint of date, amount and the plain-text payee, set once at import. It is what makes re-importing the same file harmless.
- \`dedupStatus\`: whether a staged row is already in the bank ledger (\`existing\`) or new.
- \`duplicateOfTransactionId\`: the bank row closely matches a transaction already recorded. Creating a new transaction from it is blocked until that is resolved (usually by linking instead).
- \`linkType\`: \`primary\` is the main link between a transaction and a bank row; \`extra\` is an additional one (one transaction matched to several statement lines). \`reconcile(op='accept')\` defaults to \`primary\`.
- Balance anchor: a statement's closing balance for one account on one date (one per account per day). Anchors are what \`balanceDelta\` is measured against.

## Common causes of a mismatch
- **Overlapping imports**: a monthly file and a year-to-date file share rows. Two row ids for one event; remove the extra.
- **Entered by hand and imported**: the user typed a transaction before the statement arrived. Link them (\`reconcile(op='accept')\`) rather than creating a second one.
- **Timing**: a payment clears days after the user recorded it. The fuzzy bucket catches it; confirm with the user.
- **Pending becoming posted**: banks rewrite the description, and sometimes the date or amount, when a pending charge posts. It can arrive as a new row; check before adding it.
- **No anchor yet**: \`balanceDelta\` is null until a statement balance is recorded.
- **Account mode**: an account in \`manual\` mode keeps files waiting for review; \`manage_accounts(op='set_mode')\` switches it to \`approve\` or \`auto\` if the user wants that.
`,
};
