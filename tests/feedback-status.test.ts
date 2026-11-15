/**
 * Feedback ticket statuses (2026-11-15): a user reply on a resolved ticket
 * reopens it, so a follow-up never sits unseen in the Resolved bucket on
 * /admin/feedback. An admin reply moves new and reopened tickets to triaged.
 *
 * The rules are pure (src/lib/feedback/status.ts); the static half of this file
 * pins that every surface reads them from there, because a rule's own unit
 * tests pass whether or not anything calls it.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  FEEDBACK_STATUSES,
  REOPENED_STATUS,
  REOPENS_ON_USER_REPLY,
  isFeedbackStatus,
  statusAfterAdminReply,
  statusAfterUserReply,
} from "@/lib/feedback/status";
import { feedbackReplyNotificationEmail } from "@/lib/email";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Source with comments removed, so a comment quoting old code can't satisfy a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("feedback status rules", () => {
  it("lists every status, reopened among them", () => {
    expect([...FEEDBACK_STATUSES]).toEqual(["new", "reopened", "triaged", "resolved"]);
    for (const s of FEEDBACK_STATUSES) expect(isFeedbackStatus(s)).toBe(true);
    for (const bad of ["", "open", "RESOLVED", null, undefined, 3]) {
      expect(isFeedbackStatus(bad)).toBe(false);
    }
  });

  it("a user reply reopens a resolved ticket and leaves every other status alone", () => {
    expect(REOPENS_ON_USER_REPLY).toBe("resolved");
    expect(REOPENED_STATUS).toBe("reopened");
    expect(statusAfterUserReply("resolved")).toBe("reopened");
    expect(statusAfterUserReply("new")).toBe("new");
    expect(statusAfterUserReply("triaged")).toBe("triaged");
    expect(statusAfterUserReply("reopened")).toBe("reopened");
  });

  it("an admin reply triages new and reopened tickets, never resolves or demotes", () => {
    expect(statusAfterAdminReply("new")).toBe("triaged");
    expect(statusAfterAdminReply("reopened")).toBe("triaged");
    expect(statusAfterAdminReply("triaged")).toBe("triaged");
    expect(statusAfterAdminReply("resolved")).toBe("resolved");
  });
});

describe("the reply email says when a reply reopened the ticket", () => {
  const base = { to: "a@example.com", feedbackId: 7, body: "still broken", userId: "u1" };

  it("marks a reopening reply", () => {
    const msg = feedbackReplyNotificationEmail({ ...base, reopened: true });
    expect(msg.subject).toBe("[Finlynq feedback] reply on #7 (reopened)");
    expect(msg.text).toContain("(reopened)");
  });

  it("leaves an ordinary reply as it was", () => {
    const msg = feedbackReplyNotificationEmail(base);
    expect(msg.subject).toBe("[Finlynq feedback] reply on #7");
    expect(msg.text).not.toContain("reopened");
  });
});

describe("every surface reads the status rules from status.ts", () => {
  it("the user reply route reopens in the same UPDATE, from the shared constants", () => {
    const src = code("src/app/api/feedback/[id]/reply/route.ts");
    expect(src).toMatch(
      /status:\s*sql`CASE WHEN \$\{schema\.feedback\.status\} = \$\{REOPENS_ON_USER_REPLY\} THEN \$\{REOPENED_STATUS\} ELSE \$\{schema\.feedback\.status\} END`/,
    );
    expect(src).toMatch(/reopened,\s*\}\)\.catch/);
  });

  it("the admin reply route triages through statusAfterAdminReply", () => {
    const src = code("src/app/api/admin/feedback/[id]/reply/route.ts");
    expect(src).toContain("statusAfterAdminReply(existing.status)");
    expect(src).not.toMatch(/=== "new" \? "triaged"/);
  });

  it("the status change, the list filter and the admin page accept every status", () => {
    expect(code("src/app/api/admin/feedback/[id]/route.ts")).toContain(
      "status: z.enum(FEEDBACK_STATUSES)",
    );
    expect(code("src/app/api/admin/feedback/route.ts")).toContain(
      "isFeedbackStatus(statusParam)",
    );
    const page = code("src/app/(app)/admin/feedback/page.tsx");
    expect(page).toContain('const FILTERS = ["all", ...FEEDBACK_STATUSES]');
    expect(page).toContain("FEEDBACK_STATUSES.map(");
    expect(page).toContain("statusAfterAdminReply(t.status)");
    expect(page).not.toMatch(/\["new", "triaged", "resolved"\]/);
  });

  it("ships the one-time backfill for tickets already stuck in resolved", () => {
    const rel = "scripts/migrations/20261115_feedback_reopen_unread_user_replies.sql";
    expect(existsSync(path.join(ROOT, rel))).toBe(true);
    const sql = read(rel)
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).toContain("SET status = 'reopened'");
    expect(sql).toContain("f.status = 'resolved'");
    expect(sql).toContain("last_msg.author_role = 'user'");
    expect(sql).toContain("last_msg.created_at >= f.updated_at");
    expect(sql).toContain("COALESCE(f.admin_last_read_at, 'epoch'::timestamptz)");
  });
});
