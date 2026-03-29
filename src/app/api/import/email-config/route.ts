import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { randomUUID, randomBytes } from "crypto";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const emailSetting = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "import_email"))
      .get();

    return NextResponse.json({
      email: emailSetting?.value ?? null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to get email config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const uuid = randomUUID().slice(0, 8);
    const email = `import-${uuid}@pf.app`;
    const webhookSecret = randomBytes(32).toString("hex");

    // Upsert email address
    db.insert(schema.settings)
      .values({ key: "import_email", value: email })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: email } })
      .run();

    // Upsert webhook secret
    db.insert(schema.settings)
      .values({ key: "email_webhook_secret", value: webhookSecret })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: webhookSecret } })
      .run();

    return NextResponse.json({ email, webhookSecret });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to generate email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
