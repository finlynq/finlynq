-- securities.isin_ct / isin_lookup — remember a security's ISIN (GH #365).
--
-- An ISIN typed into a ticker field, an import's Ticker column, or MCP
-- manage_holdings is resolved to the Yahoo symbol it trades under, and that
-- symbol is what clusters the security. Keeping the ISIN on the security lets
-- later lookups and imports match it from the user's own data before asking
-- Yahoo. Encrypted like symbol_ct (an ISIN reveals what you hold just as a
-- ticker does): isin_ct under the user DEK, isin_lookup the HMAC for exact
-- matching. Both nullable; existing securities simply have none.
--
-- Additive + idempotent.

ALTER TABLE securities ADD COLUMN IF NOT EXISTS isin_ct TEXT;
ALTER TABLE securities ADD COLUMN IF NOT EXISTS isin_lookup TEXT;

CREATE INDEX IF NOT EXISTS securities_user_isin_lookup_idx
  ON securities (user_id, isin_lookup);
