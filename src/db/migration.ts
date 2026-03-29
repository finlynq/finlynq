import Database from "better-sqlite3-multiple-ciphers";
import type BetterSqlite3 from "better-sqlite3";
import { deriveKey } from "@shared/crypto";
import fs from "fs";

export type DbState = "missing" | "unencrypted" | "encrypted";

export function detectDbState(dbPath: string): DbState {
  if (!fs.existsSync(dbPath)) {
    return "missing";
  }

  try {
    // Try opening without encryption key
    const sqlite = new (Database as unknown as typeof BetterSqlite3)(dbPath, {
      readonly: true,
    });
    try {
      sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
      sqlite.close();
      return "unencrypted";
    } catch {
      sqlite.close();
      return "encrypted";
    }
  } catch {
    // Can't even open the file — treat as encrypted (or corrupt)
    return "encrypted";
  }
}

export function migrateToEncrypted(
  dbPath: string,
  passphrase: string,
  salt: Buffer
): void {
  const hexKey = deriveKey(passphrase, salt);

  // Open existing unencrypted database
  const sqlite = new (Database as unknown as typeof BetterSqlite3)(dbPath);

  // Verify it's actually unencrypted
  try {
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch {
    sqlite.close();
    throw new Error(
      "Database appears to be already encrypted or corrupted. Cannot migrate."
    );
  }

  // Encrypt in place using the attach + export pattern
  // 1. Create a temporary encrypted copy
  const tempPath = dbPath + ".encrypting";

  try {
    // Remove temp file if it exists from a previous failed attempt
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    // Create new encrypted database
    const encryptedDb = new (Database as unknown as typeof BetterSqlite3)(
      tempPath
    );
    encryptedDb.pragma(`key = "x'${hexKey}'"`);
    encryptedDb.pragma("journal_mode = WAL");
    encryptedDb.pragma("foreign_keys = OFF");

    // Get all SQL to recreate the schema and data
    const tables = sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { sql: string }[];
    const indexes = sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
      )
      .all() as { sql: string }[];

    // Create tables in encrypted DB
    for (const { sql } of tables) {
      encryptedDb.exec(sql);
    }

    // Copy data table by table
    const tableNames = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[];

    for (const { name } of tableNames) {
      const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all();
      if (rows.length === 0) continue;

      const columns = Object.keys(rows[0] as Record<string, unknown>);
      const placeholders = columns.map(() => "?").join(", ");
      const columnNames = columns.map((c) => `"${c}"`).join(", ");
      const insert = encryptedDb.prepare(
        `INSERT INTO "${name}" (${columnNames}) VALUES (${placeholders})`
      );

      const insertMany = encryptedDb.transaction(
        (data: Record<string, unknown>[]) => {
          for (const row of data) {
            insert.run(...columns.map((c) => row[c]));
          }
        }
      );
      insertMany(rows as Record<string, unknown>[]);
    }

    // Create indexes
    for (const { sql } of indexes) {
      encryptedDb.exec(sql);
    }

    // Verify FK integrity now that all data is in place
    encryptedDb.pragma("foreign_keys = ON");
    const fkErrors = encryptedDb.pragma("foreign_key_check") as unknown[];
    if (fkErrors.length > 0) {
      encryptedDb.close();
      throw new Error("Foreign key integrity check failed after migration.");
    }

    encryptedDb.close();
    sqlite.close();

    // Replace original with encrypted version
    // Remove WAL/SHM files from unencrypted DB
    if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
    if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");

    fs.renameSync(tempPath, dbPath);
  } catch (error) {
    // Clean up temp file on failure
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    sqlite.close();
    throw error;
  }
}
