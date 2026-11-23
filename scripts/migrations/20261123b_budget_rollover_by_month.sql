-- Rollover on/off by month (2026-11-23, owner request).
--
-- Rollover was one flag per line (budget_line_settings.rollover) with no month,
-- so switching it off while looking at a future month switched it off for
-- every month, and the carry history of earlier months disappeared.
--
-- budget_carryover_sets already holds, per line and month, where the carry
-- walk starts (turning rollover on writes a 0 there; a reset or a hand-set
-- amount writes its own). An `off` row now means "rollover is off from this
-- month": a month rolls over when the latest row at or before it is not off.
-- Turning rollover on or off writes a row for the month being viewed and
-- clears rows after it, so months before it keep what they had.
--
-- Existing lines keep exactly what they show today: a line whose rollover is
-- off has every row marked off (off in every month, as now); a line whose
-- rollover is on keeps its rows as they are.

ALTER TABLE budget_carryover_sets ADD COLUMN IF NOT EXISTS off boolean NOT NULL DEFAULT false;

UPDATE budget_carryover_sets s
   SET off = true
 WHERE s.off = false
   AND NOT EXISTS (
     SELECT 1 FROM budget_line_settings ls
      WHERE ls.user_id = s.user_id
        AND ls.rollover
        AND (
          (s.category_id IS NOT NULL AND ls.category_id = s.category_id)
          OR (s.group_name IS NOT NULL AND ls.group_name = s.group_name)
        )
   );
