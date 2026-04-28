import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  runWealthPositionPreview,
  type MappingInput,
} from "@/lib/external-import/orchestrator";
import { WealthPositionApiError } from "@finlynq/import-connectors/wealthposition";

const autoCreateAccountSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().min(1).max(10),
    group: z.string().max(200),
    currency: z.string().min(1).max(10),
  })
  .optional();

const autoCreateCategorySchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().min(1).max(10),
    group: z.string().max(200),
  })
  .optional();

const mappingInputSchema = z.object({
  accounts: z
    .array(
      z.object({
        externalId: z.string().min(1),
        finlynqId: z.number().int().optional(),
        autoCreate: autoCreateAccountSchema,
      }),
    )
    .max(1000),
  categories: z
    .array(
      z.object({
        externalId: z.string().min(1),
        finlynqId: z.number().int().optional(),
        uncategorized: z.boolean().optional(),
        autoCreate: autoCreateCategorySchema,
      }),
    )
    .max(1000),
  transferCategoryId: z.number().int().nullable(),
  transferCategoryAutoCreate: z
    .object({ name: z.string().min(1).max(200), group: z.string().max(200) })
    .optional(),
  openingBalanceCategoryId: z.number().int().nullable(),
  openingBalanceCategoryAutoCreate: z
    .object({ name: z.string().min(1).max(200), group: z.string().max(200) })
    .optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = mappingInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid mapping input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const input = parsed.data as MappingInput;

  try {
    const result = await runWealthPositionPreview(auth.userId, auth.dek, input);
    return NextResponse.json({
      preview: result.preview,
      splits: result.splits,
      transformErrors: result.transformErrors,
      externalTotal: result.externalTotal,
      confirmationToken: result.confirmationToken,
      syncWatermark: result.syncWatermark,
      externalAccounts: result.externalAccounts,
      externalCategories: result.externalCategories,
    });
  } catch (err) {
    if (err instanceof WealthPositionApiError) {
      const status = err.httpStatus === 401 || err.code === "AUTHENTICATION_ERROR" ? 401 : 502;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    const message = err instanceof Error ? err.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
