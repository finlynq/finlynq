import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { runZipPreview } from "@/lib/external-import/zip-orchestrator";
import type { MappingInput } from "@/lib/external-import/orchestrator";

const MAX_ZIP_BYTES = 10 * 1024 * 1024;

const autoCreateAccountSchema = z
  .object({ name: z.string().min(1).max(200), type: z.string().min(1).max(10), group: z.string().max(200), currency: z.string().min(1).max(10) })
  .optional();
const autoCreateCategorySchema = z
  .object({ name: z.string().min(1).max(200), type: z.string().min(1).max(10), group: z.string().max(200) })
  .optional();

const mappingSchema = z.object({
  accounts: z.array(z.object({ externalId: z.string().min(1), finlynqId: z.number().int().optional(), autoCreate: autoCreateAccountSchema })).max(1000),
  categories: z.array(z.object({ externalId: z.string().min(1), finlynqId: z.number().int().optional(), uncategorized: z.boolean().optional(), autoCreate: autoCreateCategorySchema })).max(1000),
  transferCategoryId: z.number().int().nullable(),
  transferCategoryAutoCreate: z.object({ name: z.string().min(1).max(200), group: z.string().max(200) }).optional(),
  openingBalanceCategoryId: z.number().int().nullable(),
  openingBalanceCategoryAutoCreate: z.object({ name: z.string().min(1).max(200), group: z.string().max(200) }).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const cl = Number(request.headers.get("content-length") ?? 0);
  if (cl && cl > MAX_ZIP_BYTES * 2) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const form = await request.formData();
  const file = form.get("file");
  const mappingJson = form.get("mapping");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing 'file' form field" }, { status: 400 });
  if (file.size > MAX_ZIP_BYTES) return NextResponse.json({ error: "ZIP exceeds 10 MB" }, { status: 413 });
  if (typeof mappingJson !== "string") return NextResponse.json({ error: "Missing 'mapping' form field" }, { status: 400 });

  let mappingParsed: unknown;
  try { mappingParsed = JSON.parse(mappingJson); } catch { return NextResponse.json({ error: "Invalid mapping JSON" }, { status: 400 }); }
  const parsed = mappingSchema.safeParse(mappingParsed);
  if (!parsed.success) return NextResponse.json({ error: "Invalid mapping", details: parsed.error.flatten() }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const result = await runZipPreview(auth.userId, buffer, parsed.data as MappingInput);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
