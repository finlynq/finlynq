-- GH #428 (2026-11-21): "Not a subscription" for a detected suggestion.
--
-- The Subscriptions page suggests payees with regular charges. Until now the
-- only way to hide one was to track it and mark it Cancelled, and deleting
-- that row brought the suggestion back. One row here per payee the user said
-- is not a subscription; the detected lists (GET /api/recurring, the REST
-- detect action, MCP detect_subscriptions) leave those payees out.
--
-- The payee is ENCRYPTED with the user's key like every other payee
-- (payee_ct), and matched through payee_lookup: the same keyed hash of the
-- normalized name (lowercase, whitespace collapsed) that name_lookup columns
-- use, so " Hydro  One" and "hydro one" are one dismissal.

CREATE TABLE IF NOT EXISTS subscription_dismissals (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  payee_ct text NOT NULL,
  payee_lookup text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_dismissals_user_lookup_uq
  ON subscription_dismissals (user_id, payee_lookup);
