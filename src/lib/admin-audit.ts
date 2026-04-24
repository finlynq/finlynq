/**
 * Admin-action audit log (Finding #16).
 *
 * Fire-and-forget — if the audit write fails, the caller's action still
 * proceeds but the error is logged. We never want a DB hiccup on the audit
 * path to block a legitimate admin op. Conversely, we don't silently swallow
 * — the error goes to server-logger so ops can spot write failures.
 *
 * The audit log is append-only by convention (no UPDATE/DELETE helpers here).
 * A future hardening step could enforce this via a Postgres role with INSERT-only
 * grants on admin_audit for the app's DB user.
 */

import { db, schema } from "@/db";
import { NextRequest } from "next/server";

export type AdminAuditAction =
  | "role_change"
  | "plan_change"
  | "inbox_triaged"
  | "inbox_promoted"
  | "inbox_deleted"
  | "user_deleted";

export async function logAdminAction(opts: {
  adminUserId: string;
  targetUserId?: string | null;
  action: AdminAuditAction;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
}): Promise<void> {
  try {
    await db.insert(schema.adminAudit).values({
      adminUserId: opts.adminUserId,
      targetUserId: opts.targetUserId ?? null,
      action: opts.action,
      beforeJson: opts.before ? JSON.stringify(opts.before) : null,
      afterJson: opts.after ? JSON.stringify(opts.after) : null,
      ip: opts.ip ?? null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[admin-audit] insert failed", err);
  }
}

export function clientIp(request: NextRequest): string | null {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return null;
}
