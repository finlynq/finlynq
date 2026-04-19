import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { randomUUID, randomBytes } from "crypto";
import { requireAuth } from "@/lib/auth/require-auth";

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
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const uuid = randomUUID().slice(0, 8);
    const email = `import-${uuid}@pf.app`;
    const webhookSecret = randomBytes(32).toString("hex");

    // Upsert email address
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.insert(schema.settings)
      .values({ key: "import_email", value: email, userId })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: email } as any })
      ;

    // Upsert webhook secret
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.insert(schema.settings)
      .values({ key: "email_webhook_secret", value: webhookSecret, userId })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: webhookSecret } as any })
      ;

    return NextResponse.json({ email, webhookSecret });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to generate email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
