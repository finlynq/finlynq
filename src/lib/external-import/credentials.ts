// Per-user encrypted credential storage for external import connectors.
// Uses the same AES-GCM envelope as payee/note/tags (src/lib/crypto/envelope.ts)
// so the raw credential never hits disk in plaintext.
//
// Rows live in the `settings` table under a connector-scoped key:
//   key = "connector:<connectorId>:credentials"
//   value = encryptField(dek, JSON.stringify(credentials))

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { encryptField, decryptField } from "@/lib/crypto/envelope";

function credentialKey(connectorId: string): string {
  return `connector:${connectorId}:credentials`;
}

export async function saveConnectorCredentials(
  userId: string,
  connectorId: string,
  dek: Buffer,
  credentials: Record<string, string>,
): Promise<void> {
  const json = JSON.stringify(credentials);
  const ciphertext = encryptField(dek, json);
  if (!ciphertext) throw new Error("Failed to encrypt credentials");
  const key = credentialKey(connectorId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  await dbAny.execute(sql`
    INSERT INTO settings (key, user_id, value)
    VALUES (${key}, ${userId}, ${ciphertext})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
  `);
}

export async function loadConnectorCredentials<T extends Record<string, string>>(
  userId: string,
  connectorId: string,
  dek: Buffer,
): Promise<T | null> {
  const row = await db
    .select()
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, credentialKey(connectorId)),
        eq(schema.settings.userId, userId),
      ),
    )
    .get();
  if (!row?.value) return null;
  let plaintext: string | null = null;
  try {
    plaintext = decryptField(dek, row.value);
  } catch {
    // Auth-tag mismatch — credentials were encrypted under a different DEK.
    // Return null so the connector treats this as "no credentials saved";
    // the user can re-save and re-encrypt under the current DEK.
    return null;
  }
  if (!plaintext) return null;
  try {
    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}

export async function hasConnectorCredentials(
  userId: string,
  connectorId: string,
): Promise<boolean> {
  const row = await db
    .select()
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, credentialKey(connectorId)),
        eq(schema.settings.userId, userId),
      ),
    )
    .get();
  return !!row?.value;
}

export async function deleteConnectorCredentials(
  userId: string,
  connectorId: string,
): Promise<void> {
  await db
    .delete(schema.settings)
    .where(
      and(
        eq(schema.settings.key, credentialKey(connectorId)),
        eq(schema.settings.userId, userId),
      ),
    );
}
