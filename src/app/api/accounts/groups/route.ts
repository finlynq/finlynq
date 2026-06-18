/**
 * PATCH /api/accounts/groups — owner-scoped bulk rename / merge of an account
 * group (FINLYNQ-179).
 *
 * Renaming a group is a single owner-scoped bulk UPDATE:
 *   UPDATE accounts SET "group"=:to WHERE lower("group")=lower(:from) AND user_id=:me [AND type=:type]
 * Merging into "Other" is the same operation with `to: "Other"`.
 *
 * `accounts.group` is a PLAINTEXT column — no DEK required, so this gates on
 * `auth` (not `encryption`). The match is owner-scoped: a different user's
 * identically-named group is never touched.
 *
 * Enveloped response `{ success: true, data: { renamed: number } }` — brand-new
 * route, only the web Manage-groups dialog consumes it (no bare-shape client).
 */

import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { type AccountGroupType } from "@/lib/accounts/groups";
import { renameAccountGroup } from "@/lib/accounts/groups-server";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  // Optional: scope the rename to one account type. Omit to rename across both.
  type: z.enum(["A", "L"]).optional(),
});

export const PATCH = apiHandler(
  { auth: "auth", body: patchSchema, fallbackMessage: "Failed to rename group" },
  async ({ userId, body }) => {
    const renamed = await renameAccountGroup(
      userId,
      body.from,
      body.to,
      body.type as AccountGroupType | undefined,
    );
    return { renamed };
  },
);
