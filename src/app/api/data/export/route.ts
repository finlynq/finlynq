import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { pbkdf2Sync, randomBytes, createCipheriv } from "crypto";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptField } from "@/lib/crypto/envelope";
import { safeErrorMessage } from "@/lib/validate";
import { validatePasswordStrength } from "@/lib/auth/password-policy";

// Finding #8 — optional passphrase-wrap for backup exports.
// Format when wrapped:
//   {"v": "pf-backup-1", "kdf": "pbkdf2-sha256", "iters": 600000,
//    "salt": "<b64 16>", "iv": "<b64 12>", "tag": "<b64 16>",
//    "ciphertext": "<b64>"}
// On import, client derives a 32-byte key with PBKDF2-SHA256(passphrase, salt,
// iters, 32) and AES-GCM-decrypts the ciphertext. The inner plaintext is the
// same JSON as the non-wrapped export (so import code only needs one format).
const PBKDF2_ITERS = 600_000;
const PBKDF2_SALT_LEN = 16;
const WRAP_IV_LEN = 12;
const WRAP_KEY_LEN = 32;

function wrapBackupWithPassphrase(jsonBody: string, passphrase: string): string {
  const salt = randomBytes(PBKDF2_SALT_LEN);
  const iv = randomBytes(WRAP_IV_LEN);
  const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERS, WRAP_KEY_LEN, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(jsonBody, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify(
    {
      v: "pf-backup-1",
      kdf: "pbkdf2-sha256",
      iters: PBKDF2_ITERS,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ct.toString("base64"),
    },
    null,
    2
  );
}

function decryptRowFields(dek: Buffer | null, row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  if (!dek) return row;
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string") {
      out[f] = decryptField(dek, v) ?? v;
    }
  }
  return out;
}

const TX_FIELDS = ["payee", "note", "tags", "portfolioHolding"] as const;
const SPLIT_FIELDS = ["note", "description", "tags"] as const;

// POST accepts `{ passphrase: string }` to passphrase-wrap the export —
// Finding #8. Both GET and POST share the same body builder below.
export async function POST(request: NextRequest) {
  return handleExport(request);
}

export async function GET(request: NextRequest) {
  return handleExport(request);
}

async function handleExport(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  // Export tolerates a missing DEK — without it, encrypted rows ship as
  // ciphertext (still restoreable into the same account).
  const dek = sessionId ? getDEK(sessionId) : null;

  try {
    const [
      accounts,
      categories,
      transactions,
      portfolioHoldings,
      budgets,
      budgetTemplates,
      loans,
      goals,
      snapshots,
      targetAllocations,
      recurringTransactions,
      subscriptions,
      transactionRules,
      importTemplates,
      fxRates,
      settingsRows,
      contributionRoom,
    ] = await Promise.all([
      db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)),
      db.select().from(schema.categories).where(eq(schema.categories.userId, userId)),
      db.select().from(schema.transactions).where(eq(schema.transactions.userId, userId)),
      db.select().from(schema.portfolioHoldings).where(eq(schema.portfolioHoldings.userId, userId)),
      db.select().from(schema.budgets).where(eq(schema.budgets.userId, userId)),
      db.select().from(schema.budgetTemplates).where(eq(schema.budgetTemplates.userId, userId)),
      db.select().from(schema.loans).where(eq(schema.loans.userId, userId)),
      db.select().from(schema.goals).where(eq(schema.goals.userId, userId)),
      db.select().from(schema.snapshots).where(eq(schema.snapshots.userId, userId)),
      db.select().from(schema.targetAllocations).where(eq(schema.targetAllocations.userId, userId)),
      db.select().from(schema.recurringTransactions).where(eq(schema.recurringTransactions.userId, userId)),
      db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId)),
      db.select().from(schema.transactionRules).where(eq(schema.transactionRules.userId, userId)),
      db.select().from(schema.importTemplates).where(eq(schema.importTemplates.userId, userId)),
      db.select().from(schema.fxRates).where(eq(schema.fxRates.userId, userId)),
      db.select().from(schema.settings).where(eq(schema.settings.userId, userId)),
      db.select().from(schema.contributionRoom).where(eq(schema.contributionRoom.userId, userId)),
    ]);

    // Transaction splits have no userId — filter by user's transaction IDs
    const txIds = transactions.map((t) => t.id);
    const transactionSplits =
      txIds.length > 0
        ? await db.select().from(schema.transactionSplits).where(inArray(schema.transactionSplits.transactionId, txIds))
        : [];

    // Decrypt text fields so the backup is portable (user can restore into
    // a fresh account with a different DEK). Backup files are downloaded to
    // the user's device; they're responsible for securing them at rest.
    const decryptedTransactions = transactions.map((t) => decryptRowFields(dek, t, TX_FIELDS));
    const decryptedSplits = transactionSplits.map((s) => decryptRowFields(dek, s, SPLIT_FIELDS));

    const dateStr = new Date().toISOString().slice(0, 10);
    const backup = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      appVersion: "3.0",
      data: {
        accounts,
        categories,
        transactions: decryptedTransactions,
        transactionSplits: decryptedSplits,
        portfolioHoldings,
        budgets,
        budgetTemplates,
        loans,
        goals,
        snapshots,
        targetAllocations,
        recurringTransactions,
        subscriptions,
        transactionRules,
        importTemplates,
        fxRates,
        settings: settingsRows,
        contributionRoom,
      },
    };

    const jsonBody = JSON.stringify(backup, null, 2);

    // Optional passphrase-wrap — if the caller supplies a ?passphrase=..., we
    // AES-GCM the export body with a PBKDF2-derived key. The file is then
    // self-protecting: losing it to cloud sync or email attachments does not
    // leak content unless the attacker also has the passphrase. Passphrase
    // lives in the request body (POST only) rather than the URL (GET query)
    // so it doesn't end up in Caddy access logs.
    let body: string;
    let filename: string;
    let contentType: string;
    if (request.method === "POST") {
      let passphrase: string | null = null;
      try {
        const parsed = await request.json();
        if (parsed && typeof parsed.passphrase === "string") {
          passphrase = parsed.passphrase;
        }
      } catch {
        // No JSON body — fall through to plain export.
      }
      if (passphrase) {
        const strengthError = validatePasswordStrength(passphrase);
        if (strengthError) {
          return NextResponse.json(
            { error: `Backup passphrase too weak: ${strengthError}` },
            { status: 400 }
          );
        }
        body = wrapBackupWithPassphrase(jsonBody, passphrase);
        filename = `finlynq-backup-${dateStr}.pf-encrypted.json`;
        contentType = "application/json";
      } else {
        body = jsonBody;
        filename = `finlynq-backup-${dateStr}.json`;
        contentType = "application/json";
      }
    } else {
      body = jsonBody;
      filename = `finlynq-backup-${dateStr}.json`;
      contentType = "application/json";
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Export failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
