/**
 * GET/PUT /api/settings/account-group-order — per-user display ORDER of account
 * groups, scoped per account type (A=Asset, L=Liability) (FINLYNQ-179).
 *
 * Stored as a JSON object `{ A: string[], L: string[] }` under the
 * `account_group_order` key in the `settings` key/value table — NO migration
 * (mirrors `reconcile_hidden_accounts`). Order is advisory: the accounts page
 * leads with groups in the saved order and falls back to alphabetical for the
 * rest, with "Other" always last.
 *
 * Request body (PUT, JSON): { order: { A?: string[], L?: string[] } }
 * Response: { order: { A: string[], L: string[] } } (normalized, de-duped)
 *
 * Bare shape + requireAuth to match the sibling settings-key routes
 * (reconcile-hidden-accounts, email-retention, dev-mode). `accounts.group` is
 * plaintext — no DEK needed.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { parseGroupOrder, type AccountGroupOrder } from "@/lib/accounts/groups";
import {
  getAccountGroupOrder,
  setAccountGroupOrder,
} from "@/lib/accounts/groups-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const order = await getAccountGroupOrder(auth.context.userId);
  return NextResponse.json({ order });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body as { order?: unknown } | null)?.order;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NextResponse.json(
      { error: "order must be an object of { A?: string[], L?: string[] }" },
      { status: 400 },
    );
  }
  // parseGroupOrder normalizes (de-dupes, drops blanks) and never throws — a
  // malformed element is dropped rather than 500ing.
  const normalized: AccountGroupOrder = parseGroupOrder(JSON.stringify(raw));
  const order = await setAccountGroupOrder(auth.context.userId, normalized);
  return NextResponse.json({ order });
}
