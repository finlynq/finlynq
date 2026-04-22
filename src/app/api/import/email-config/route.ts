import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, sql } from "drizzle-orm";
import { randomUUID, randomBytes } from "crypto";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { wrapDEKForSecret } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const emailSetting = db
      .select()
      .from(schema.settings)
      .where(and(eq(schema.settings.key, "import_email"), eq(schema.settings.userId, userId)))
      .get();

    return NextResponse.json({
      email: emailSetting?.value ?? null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to get email config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // Needs the DEK so the webhook can encrypt imported rows — wrap it with
  // the webhook secret at config time (see /api/import/email-webhook).
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const uuid = randomUUID().slice(0, 8);
    const email = `import-${uuid}@pf.app`;
    const webhookSecret = randomBytes(32).toString("hex");
    const wrappedDek = wrapDEKForSecret(dek, webhookSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;

    // Use raw SQL with the composite PK so ON CONFLICT works per-user.
    await dbAny.execute(sql`
      INSERT INTO settings (key, user_id, value)
      VALUES ('import_email', ${userId}, ${email})
      ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
    `);
    await dbAny.execute(sql`
      INSERT INTO settings (key, user_id, value)
      VALUES ('email_webhook_secret', ${userId}, ${webhookSecret})
      ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
    `);
    await dbAny.execute(sql`
      INSERT INTO settings (key, user_id, value)
      VALUES ('email_webhook_dek', ${userId}, ${wrappedDek})
      ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
    `);

    return NextResponse.json({ email, webhookSecret });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to generate email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
