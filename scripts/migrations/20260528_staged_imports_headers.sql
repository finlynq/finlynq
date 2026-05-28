-- staged_imports.headers + sample_rows — fallback metadata for the manual
-- template/account picker when a CSV email-import attachment didn't match
-- any saved template at parse time. Both nullable; existing rows stay
-- NULL → picker UI hidden for them.
--
-- Schema match: src/db/schema-pg.ts stagedImports table (2026-05-28).
-- Idempotent (IF NOT EXISTS) so dev/staging re-runs are safe.

ALTER TABLE staged_imports ADD COLUMN IF NOT EXISTS headers JSONB;
ALTER TABLE staged_imports ADD COLUMN IF NOT EXISTS sample_rows JSONB;
