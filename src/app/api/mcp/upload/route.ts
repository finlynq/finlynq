/**
 * POST /api/mcp/upload — receive a CSV / OFX / QFX file for later import via MCP.
 *
 * Flow:
 *   1. Browser uploads a file here while the user is logged in (session cookie)
 *      or presents a valid API key. The DEK is required — without it we can't
 *      encrypt the rows when the user later calls execute_import via MCP.
 *   2. The file bytes are written to `uploads/mcp/<userId>/<uuid>.<ext>` and a
 *      row is inserted into `mcp_uploads` with status='pending'.
 *   3. The MCP tools `preview_import` and `execute_import` read the path from
 *      that row.
 *   4. A background sweep (src/lib/mcp/upload-cleanup.ts) GCs expired rows +
 *      their files after 24 h.
 *
 * Size cap: 5 MB. Allowed formats: csv, ofx, qfx.
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { db, schema } from "@/db";
import { safeErrorMessage } from "@/lib/validate";
import { encryptFileBytes } from "@/lib/crypto/file-envelope";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_FORMATS = new Set(["csv", "ofx", "qfx"]);
const TTL_MS = 24 * 60 * 60 * 1000; // 24 h

function detectFormat(filename: string, hint: string | null): string | null {
  if (hint && ALLOWED_FORMATS.has(hint.toLowerCase())) return hint.toLowerCase();
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext && ALLOWED_FORMATS.has(ext)) return ext;
  return null;
}

export async function POST(request: NextRequest) {
  // DEK required: we can't accept an upload that would later fail to encrypt.
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  // Early rejection before we start buffering if Content-Length is obviously over.
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BYTES + 64 * 1024 /* form overhead */) {
    return NextResponse.json(
      { error: `File exceeds ${MAX_BYTES} byte limit` },
      { status: 413 }
    );
  }

  try {
    const form = (await request.formData()) as unknown as globalThis.FormData;
    const fileEntry = form.get("file");
    const formatHint = (form.get("format") as string | null) ?? null;

    if (!fileEntry || !(fileEntry instanceof File)) {
      return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
    }

    if (fileEntry.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `File exceeds ${MAX_BYTES} byte limit` },
        { status: 413 }
      );
    }

    const format = detectFormat(fileEntry.name, formatHint);
    if (!format) {
      return NextResponse.json(
        { error: "Unsupported format — allowed: csv, ofx, qfx" },
        { status: 415 }
      );
    }

    const bytes = Buffer.from(await fileEntry.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      return NextResponse.json(
        { error: `File exceeds ${MAX_BYTES} byte limit` },
        { status: 413 }
      );
    }

    // Storage path: uploads/mcp/<userId>/<uuid>.<ext>
    const uploadsRoot = path.resolve(process.cwd(), "uploads", "mcp", userId);
    await fs.mkdir(uploadsRoot, { recursive: true });
    const id = crypto.randomUUID();
    const storagePath = path.join(uploadsRoot, `${id}.${format}`);
    // Finding #7 — never write the raw upload to disk. AES-GCM under the
    // user's session DEK; preview_import/execute_import decrypt on read.
    const encrypted = encryptFileBytes(dek, bytes);
    await fs.writeFile(storagePath, encrypted);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MS);

    await db.insert(schema.mcpUploads).values({
      id,
      userId,
      format,
      storagePath,
      originalFilename: fileEntry.name,
      sizeBytes: bytes.length,
      createdAt: now,
      expiresAt,
      status: "pending",
    });

    return NextResponse.json({
      uploadId: id,
      format,
      sizeBytes: bytes.length,
      originalFilename: fileEntry.name,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Upload failed") },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { error: "POST multipart/form-data with a 'file' field." },
    { status: 405, headers: { Allow: "POST" } }
  );
}
