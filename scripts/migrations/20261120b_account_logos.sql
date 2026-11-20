-- GH #420 (2026-11-20): an optional logo per account, shown instead of the
-- letter avatar.
--
-- One row per account. The image is a small PNG (normalized in the browser
-- to at most 128x128) stored as base64 and ENCRYPTED with the user's key,
-- like account names: a logo says which bank the account is at. The domain
-- it was fetched from is encrypted too. Served same-origin by
-- GET /api/accounts/[id]/logo; nothing is fetched from a third party on
-- page load.
--
-- account_id is NOT NULL and cascades off accounts, so deleting an account,
-- Clear All Data and account deletion all remove its logo.

CREATE TABLE IF NOT EXISTS account_logos (
  account_id integer PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  image_ct text NOT NULL,
  domain_ct text,
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_logos_source_check CHECK (source IN ('upload', 'domain'))
);

CREATE INDEX IF NOT EXISTS account_logos_user_idx ON account_logos (user_id);
