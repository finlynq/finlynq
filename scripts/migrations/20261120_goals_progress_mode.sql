-- GH #423 (2026-11-20): a goal can measure GROWTH since a start date instead
-- of its linked accounts' whole balance.
--
--   progress_mode 'balance' (default, every existing goal): progress = linked
--                 balance now, unchanged.
--   progress_mode 'growth': progress = linked balance now minus the balance at
--                 the end of the day before start_date (lib/goals/progress-mode.ts).
--
-- Additive: existing rows keep 'balance' and a NULL start_date, so nothing
-- about them changes.

ALTER TABLE goals ADD COLUMN IF NOT EXISTS progress_mode text NOT NULL DEFAULT 'balance';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS start_date text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goals_progress_mode_check') THEN
    ALTER TABLE goals ADD CONSTRAINT goals_progress_mode_check
      CHECK (progress_mode IN ('balance', 'growth'));
  END IF;
END $$;
