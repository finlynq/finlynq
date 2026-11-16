-- Reopen resolved feedback tickets the user has written on since (2026-11-15).
--
-- From this release a user reply on a resolved ticket moves it to the new
-- 'reopened' status (POST /api/feedback/[id]/reply, src/lib/feedback/status.ts),
-- so the follow-up shows up outside the Resolved bucket on /admin/feedback.
-- Replies sent before this release left their ticket in Resolved, with only the
-- "New reply" dot to show for it. This applies the new rule to those tickets
-- once.
--
-- A ticket is reopened only when all of these hold:
--   * its status is 'resolved';
--   * its latest message is from the user;
--   * that message is the last thing that happened to the ticket
--     (created_at >= feedback.updated_at: a reply sets updated_at to the
--     message's own time, while resolving, an admin reply or a note bumps it
--     later), so a ticket resolved AFTER the user's reply stays resolved;
--   * the maintainer has not opened the thread since (the "New reply" dot),
--     so a reply already read and deliberately left resolved stays resolved.
--
-- feedback.status has no CHECK constraint, so the new value needs no schema
-- change. Idempotent: a second run finds nothing left in 'resolved' to match.

UPDATE feedback f
SET status = 'reopened'
FROM (
  SELECT DISTINCT ON (m.feedback_id)
         m.feedback_id, m.author_role, m.created_at
  FROM feedback_messages m
  ORDER BY m.feedback_id, m.created_at DESC, m.id DESC
) last_msg
WHERE last_msg.feedback_id = f.id
  AND f.status = 'resolved'
  AND last_msg.author_role = 'user'
  AND last_msg.created_at >= f.updated_at
  AND last_msg.created_at > COALESCE(f.admin_last_read_at, 'epoch'::timestamptz);
