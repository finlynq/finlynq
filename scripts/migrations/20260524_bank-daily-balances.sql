-- Bank-side daily balance anchors (2026-05-24).
--
-- Adds a per-day anchor table that captures the bank's reported balance
-- for an account on a given date. Anchors come from three sources today:
--   - csv_column     — last-in-file-order row's "Balance" column value
--   - ofx_ledgerbal  — OFX/QFX <LEDGERBAL><BALAMT>+<DTASOF>
--   - upload_form    — user-typed statement balance + statement balance date
-- The 'email', 'connector', and 'backup_restore' source values are reserved
-- for future surfaces; only the first three fire today.
--
-- Why a separate table and not a column on `bank_transactions`:
--   - Uniqueness on (user_id, account_id, date) is a clean PK; you can't
--     accidentally double-anchor a single day.
--   - The anchor survives row deletion. An anchor is "the bank told us X
--     on date D" — it shouldn't disappear when the row that carried it
--     gets removed.
--   - Allows anchors from sources that don't have a 1:1 row (the upload
--     form's user-typed statement balance is the statement's closing
--     balance, not associated with any specific row).
--
-- Re-import semantics: ON CONFLICT (user_id, account_id, date) DO UPDATE
-- — newer balance wins, last_seen_at bumps, source_filenames appends.
-- Rationale: a re-downloaded statement from the bank with a corrected
-- value should overwrite. The user can rely on the most recent anchor
-- being the bank's most recent ground truth. Load-bearing per CLAUDE.md
-- "Bank balance anchors".
--
-- Also adds `staged_imports.parsed_anchors JSONB` to carry the parsed
-- anchors from the upload step through to the approve step. The column
-- is nullable (pre-2026-05-24 uploads have no anchors) and is wiped
-- when the staged_imports row is deleted (no separate cleanup).
--
-- Pure additive: no DROP COLUMN, no behavior change for paths that don't
-- yet read the new table. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT
-- add a BEGIN/COMMIT block here.

-- ─── bank_daily_balances table ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_daily_balances (
  user_id          TEXT              NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  account_id       INTEGER           NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- YYYY-MM-DD, matches bank_transactions.date format.
  date             TEXT              NOT NULL,
  balance          DOUBLE PRECISION  NOT NULL,
  -- ISO 4217. Captured at insert time from account.currency (or, in the
  -- OFX path, the statement's CURDEF). Used by the /reconcile header to
  -- decide whether the displayed bank-side balance needs FX conversion.
  currency         TEXT              NOT NULL,
  -- Strict subset of anchor sources today: csv_column / ofx_ledgerbal /
  -- upload_form. Future: email (Resend webhook), connector (Plaid etc.),
  -- backup_restore. Keep the CHECK in sync with the SOURCES tuple in
  -- src/lib/bank-ledger-balance.ts.
  source           TEXT              NOT NULL CHECK (source IN (
                     'csv_column','ofx_ledgerbal','upload_form',
                     'email','connector','backup_restore'
                   )),
  -- Append-only history of filenames that produced or re-confirmed this
  -- anchor. Mirrors the pattern on bank_transactions.source_filenames.
  source_filenames TEXT[]            NOT NULL DEFAULT ARRAY[]::TEXT[],
  first_seen_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id, date)
);

-- Hot path: "give me the most recent anchor for this account" — drives
-- the /reconcile header's "bank says (as of <date>): $X" display, and
-- the validation helper's "find prior anchor" lookup.
CREATE INDEX IF NOT EXISTS bank_daily_balances_account_date_desc_idx
  ON bank_daily_balances (user_id, account_id, date DESC);

-- ─── staged_imports.parsed_anchors JSONB ────────────────────────────────
--
-- Carries the parsed anchors from upload-time parsing through to approve-
-- time materialization. Shape:
--   [{ "date": "YYYY-MM-DD", "balance": 1234.56,
--      "currency": "CAD", "source": "csv_column" }, ...]
--
-- Nullable — pre-2026-05-24 staged_imports rows have no anchors. The
-- upload route persists `null` rather than `[]` when no anchors were
-- parsed (CSV without a Balance column AND no user-typed statement
-- balance AND no OFX LEDGERBAL).

ALTER TABLE staged_imports
  ADD COLUMN IF NOT EXISTS parsed_anchors JSONB;
