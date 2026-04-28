import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { runZipExecute } from "@/lib/external-import/zip-orchestrator";
import type { MappingInput } from "@/lib/external-import/orchestrator";

const MAX_ZIP_BYTES = 10 * 1024 * 1024;

const autoCreateAccountSchema = z
  .object({ name: z.string().min(1).max(200), type: z.string().min(1).max(10), group: z.string().max(200), currency: z.string().min(1).max(10) })
  .optional();
const autoCreateCategorySchema = z
  .object({ name: z.string().min(1).max(200), type: z.string().min(1).max(10), group: z.string().max(200) })
  .optional();

const payloadSchema = z.object({
  confirmationToken: z.string().min(1).max(2000),
  forceImportIndices: z.array(z.number().int().min(0)).max(50000).optional(),
  mapping: z.object({
    accounts: z.array(z.object({ externalId: z.string().min(1), finlynqId: z.number().int().optional(), autoCreate: autoCreateAccountSchema })).max(1000),
    categories: z.array(z.object({ externalId: z.string().min(1), finlynqId: z.number().int().optional(), uncategorized: z.boolean().optional(), autoCreate: autoCreateCategorySchema })).max(1000),
    transferCategoryId: z.number().int().nullable(),
    transferCategoryAutoCreate: z.object({ name: z.string().min(1).max(200), group: z.string().max(200) }).optional(),
    openingBalanceCategoryId: z.number().int().nullable(),
    openingBalanceCategoryAutoCreate: z.object({ name: z.string().min(1).max(200), group: z.string().max(200) }).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const file = form.get("file");
  const payloadJson = form.get("payload");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing 'file' form field" }, { status: 400 });
  if (file.size > MAX_ZIP_BYTES) return NextResponse.json({ error: "ZIP exceeds 10 MB" }, { status: 413 });
  if (typeof payloadJson !== "string") return NextResponse.json({ error: "Missing 'payload' form field" }, { status: 400 });

  let payloadParsed: unknown;
  try { payloadParsed = JSON.parse(payloadJson); } catch { return NextResponse.json({ error: "Invalid payload JSON" }, { status: 400 }); }
  const parsed = payloadSchema.safeParse(payloadParsed);
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const result = await runZipExecute(
      auth.userId,
      auth.dek,
      buffer,
      parsed.data.mapping as MappingInput,
      parsed.data.confirmationToken,
      parsed.data.forceImportIndices ?? [],
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execute failed";
    const status = message.includes("Confirmation token") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
