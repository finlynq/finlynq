import { NextRequest, NextResponse } from "next/server";
import {
  initializeConnection,
  isUnlocked,
  closeConnection,
  getConnection,
} from "@/db";
import { resetDb } from "@/db";
import { generateSalt, deriveKey } from "@shared/crypto";
import {
  readConfig,
  writeConfig,
  configExists,
  resolveDbPath,
} from "@shared/config";
import { detectDbState, migrateToEncrypted } from "@/db/migration";
import Database from "better-sqlite3-multiple-ciphers";
import type BetterSqlite3 from "better-sqlite3";
import fs from "fs";

export async function GET() {
  const hasConfig = configExists();
  const config = readConfig();
  const dbPath = resolveDbPath(config);
  const dbExists = fs.existsSync(dbPath);

  let needsSetup = false;
  if (!hasConfig) {
    // No config file — first launch or legacy unencrypted DB
    needsSetup = true;
  } else if (!config.salt) {
    // Config exists but no salt — needs encryption setup
    needsSetup = true;
  }

  return NextResponse.json({
    unlocked: isUnlocked(),
    needsSetup,
    mode: config.mode,
    hasExistingData: dbExists && !hasConfig,
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action, passphrase, newPassphrase, dbPath, mode } = body;

  try {
    switch (action) {
      case "setup":
        return handleSetup(passphrase, dbPath, mode);
      case "lock":
        return handleLock();
      case "rekey":
        return handleRekey(passphrase, newPassphrase);
      default:
        return handleUnlock(passphrase);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

function handleUnlock(passphrase: string) {
  if (!passphrase) {
    return NextResponse.json(
      { error: "Passphrase is required" },
      { status: 400 }
    );
  }

  resetDb();
  initializeConnection(passphrase);
  return NextResponse.json({ success: true });
}

function handleLock() {
  resetDb();
  closeConnection();
  return NextResponse.json({ success: true });
}

function handleSetup(
  passphrase: string,
  dbPath?: string,
  mode?: "local" | "cloud"
) {
  if (!passphrase || passphrase.length < 8) {
    return NextResponse.json(
      { error: "Passphrase must be at least 8 characters" },
      { status: 400 }
    );
  }

  const config = readConfig();
  const resolvedPath = dbPath || resolveDbPath(config);
  const salt = generateSalt();
  const dbState = detectDbState(resolvedPath);

  if (dbState === "unencrypted") {
    // Migrate existing unencrypted DB to encrypted
    migrateToEncrypted(resolvedPath, passphrase, salt);
  } else if (dbState === "missing") {
    // Create new encrypted DB
    const hexKey = deriveKey(passphrase, salt);
    const sqlite = new (Database as unknown as typeof BetterSqlite3)(
      resolvedPath
    );
    sqlite.pragma(`key = "x'${hexKey}'"`);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    // Create a marker table to verify encryption works
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS _encryption_check (id INTEGER PRIMARY KEY)"
    );
    sqlite.close();
  }

  // Save config
  writeConfig({
    dbPath: dbPath || config.dbPath,
    mode: mode || config.mode,
    salt: salt.toString("hex"),
  });

  // Now unlock with the new passphrase
  resetDb();
  initializeConnection(passphrase, resolvedPath, mode || config.mode);

  return NextResponse.json({ success: true });
}

function handleRekey(currentPassphrase: string, newPassphrase: string) {
  if (!currentPassphrase || !newPassphrase) {
    return NextResponse.json(
      { error: "Both current and new passphrases are required" },
      { status: 400 }
    );
  }
  if (newPassphrase.length < 8) {
    return NextResponse.json(
      { error: "New passphrase must be at least 8 characters" },
      { status: 400 }
    );
  }

  // Ensure DB is unlocked with current passphrase
  if (!isUnlocked()) {
    resetDb();
    initializeConnection(currentPassphrase);
  }

  const config = readConfig();
  const newSalt = generateSalt();
  const newHexKey = deriveKey(newPassphrase, newSalt);

  // Re-encrypt database with new key
  const sqlite = getConnection();
  sqlite.pragma(`rekey = "x'${newHexKey}'"`);

  // Update config with new salt
  writeConfig({
    ...config,
    salt: newSalt.toString("hex"),
  });

  // Reconnect with new passphrase
  resetDb();
  closeConnection();
  initializeConnection(newPassphrase);

  return NextResponse.json({ success: true });
}
