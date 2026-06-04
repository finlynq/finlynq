/**
 * PATCH /api/accounts/[id]/import-prefs — statement-upload field-mapping
 * preferences (2026-06-04).
 *
 * Updates the per-account import field-mapping knobs:
 *
 *   ofx_payee_source — 'name' | 'memo' — which OFX/QFX field populates the
 *                      canonical `payee` column (NAME-first vs MEMO-first).
 *   csv_mapping_mode  — 'confirm' | 'auto' — whether a CSV upload's detected
 *                      column mapping is confirmed before staging.
 *
 * Both are independently optional; send only the one(s) you want to change.
 * At least one must be present. Mirrors the PATCH /api/accounts/[id]/mode
 * shape: owner-scoped (a stranger flipping another tenant's account gets a
 * 404), envelope response.
 *
 * Request body (JSON):
 *   { ofxPayeeSource?: "name" | "memo", csvMappingMode?: "confirm" | "auto" }
 *
 * Response shapes:
 *   200 — { success: true, data: { id, ofxPayeeSource, csvMappingMode } }
 *   400 — { error: "..." } (no valid field / invalid value)
 *   404 — { error: "Not found" } (stranger or no such account)
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

export const dynamic = "force-dynamic";

const VALID_PAYEE_SOURCES = ["name", "memo"] as const;
type OfxPayeeSource = (typeof VALID_PAYEE_SOURCES)[number];

const VALID_CSV_MODES = ["confirm", "auto"] as const;
type CsvMappingMode = (typeof VALID_CSV_MODES)[number];

function isPayeeSource(value: unknown): value is OfxPayeeSource {
  return (
    typeof value === "string" &&
    (VALID_PAYEE_SOURCES as readonly string[]).includes(value)
  );
}

function isCsvMappingMode(value: unknown): value is CsvMappingMode {
  return (
    typeof value === "string" &&
    (VALID_CSV_MODES as readonly string[]).includes(value)
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id: rawId } = await params;

  const id = Number(rawId);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body ?? {}) as {
    ofxPayeeSource?: unknown;
    csvMappingMode?: unknown;
  };

  const set: { ofxPayeeSource?: OfxPayeeSource; csvMappingMode?: CsvMappingMode } =
    {};

  if (raw.ofxPayeeSource !== undefined) {
    if (!isPayeeSource(raw.ofxPayeeSource)) {
      return NextResponse.json(
        { error: "ofxPayeeSource must be 'name' or 'memo'" },
        { status: 400 },
      );
    }
    set.ofxPayeeSource = raw.ofxPayeeSource;
  }

  if (raw.csvMappingMode !== undefined) {
    if (!isCsvMappingMode(raw.csvMappingMode)) {
      return NextResponse.json(
        { error: "csvMappingMode must be 'confirm' or 'auto'" },
        { status: 400 },
      );
    }
    set.csvMappingMode = raw.csvMappingMode;
  }

  if (Object.keys(set).length === 0) {
    return NextResponse.json(
      { error: "Provide ofxPayeeSource and/or csvMappingMode" },
      { status: 400 },
    );
  }

  try {
    const updated = await db
      .update(schema.accounts)
      .set(set)
      .where(
        and(
          eq(schema.accounts.id, id),
          eq(schema.accounts.userId, userId),
        ),
      )
      .returning({
        id: schema.accounts.id,
        ofxPayeeSource: schema.accounts.ofxPayeeSource,
        csvMappingMode: schema.accounts.csvMappingMode,
      });

    if (updated.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: {
        id: updated[0].id,
        ofxPayeeSource: updated[0].ofxPayeeSource,
        csvMappingMode: updated[0].csvMappingMode,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to update import preferences") },
      { status: 500 },
    );
  }
}
