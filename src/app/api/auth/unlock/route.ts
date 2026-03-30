import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  initializeConnection,
  isUnlocked,
  closeConnection,
  getConnection,
  getDialect,
} from "@/db";
import { resetDb, SqliteAdapter } from "@/db";
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
import { checkRateLimit } from "@/lib/rate-limit";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const unlockSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("setup"),
    passphrase: z.string().min(8, "Passphrase must be at least 8 characters"),
    dbPath: z.string().optional(),
    mode: z.enum(["local", "cloud"]).optional(),
  }),
  z.object({
    action: z.literal("unlock"),
    passphrase: z.string().min(1, "Passphrase is required"),
  }),
  z.object({
    action: z.literal("lock"),
  }),
  z.object({
    action: z.literal("rekey"),
    passphrase: z.string().min(1, "Current passphrase is required"),
    newPassphrase: z.string().min(8, "New passphrase must be at least 8 characters"),
  }),
]);

// Default action for backwards compatibility (no action = unlock)
const bodyPreprocess = z.object({
  action: z.string().optional(),
  passphrase: z.string().optional(),
  newPassphrase: z.string().optional(),
  dbPath: z.string().optional(),
  mode: z.enum(["local", "cloud"]).optional(),
}).transform((val) => ({
  ...val,
  action: val.action || "unlock",
}));

export async function GET() {
  const dialect = getDialect();

  // In managed mode, passphrase unlock is not applicable
  if (dialect === "postgres") {
    return NextResponse.json({
      unlocked: true,
      needsSetup: false,
      mode: "managed",
      authMethod: "account",
      hasExistingData: false,
    });
  }

  const hasConfig = configExists();
  const config = readConfig();
  const dbPath = resolveDbPath(config);
  const dbExists = fs.existsSync(dbPath);

  let needsSetup = false;
  if (!hasConfig) {
    needsSetup = true;
  } else if (!config.salt) {
    needsSetup = true;
  }

  return NextResponse.json({
    unlocked: isUnlocked(),
    needsSetup,
    mode: config.mode,
    authMethod: "passphrase",
    hasExistingData: dbExists && !hasConfig,
  });
}

export async function POST(request: NextRequest) {
  // Rate limit: 5 attempts per 60 seconds per IP
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkRateLimit(`auth:${ip}`, 5, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
        },
      }
    );
  }

  // Passphrase operations are only for self-hosted mode
  if (getDialect() === "postgres") {
    return NextResponse.json(
      { error: "Passphrase unlock is not available in managed mode. Use /api/auth/login instead." },
      { status: 403 }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Preprocess to add default action
  const preprocessed = bodyPreprocess.safeParse(rawBody);
  if (!preprocessed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const validated = validateBody(preprocessed.data, unlockSchema);
  if (validated.error) return validated.error;

  const body = validated.data;

  try {
    switch (body.action) {
      case "setup":
        return handleSetup(body.passphrase, body.dbPath, body.mode);
      case "lock":
        return handleLock();
      case "rekey":
        return handleRekey(body.passphrase, body.newPassphrase);
      default:
        return handleUnlock(body.passphrase);
    }
  } catch (error) {
    const message = safeErrorMessage(error, "Authentication operation failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

function handleUnlock(passphrase: string) {
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
  const config = readConfig();
  const resolvedPath = dbPath || resolveDbPath(config);
  const salt = generateSalt();
  const dbState = detectDbState(resolvedPath);

  if (dbState === "encrypted") {
    return NextResponse.json(
      {
        error:
          "An encrypted database already exists at this path. Use the 'unlock' action with your original passphrase, or delete the database file to start fresh.",
      },
      { status: 409 }
    );
  }

  if (dbState === "unencrypted") {
    migrateToEncrypted(resolvedPath, passphrase, salt);
  } else if (dbState === "missing") {
    const hexKey = deriveKey(passphrase, salt);
    const sqlite = new (Database as unknown as typeof BetterSqlite3)(
      resolvedPath
    );
    sqlite.pragma(`key = "x'${hexKey}'"`);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS _encryption_check (id INTEGER PRIMARY KEY)"
    );
    sqlite.close();
  }

  writeConfig({
    dbPath: dbPath || config.dbPath,
    mode: mode || config.mode,
    salt: salt.toString("hex"),
  });

  resetDb();
  initializeConnection(passphrase, resolvedPath, mode || config.mode);

  // Run schema migrations so all tables are available immediately after setup
  const adapter = new SqliteAdapter();
  adapter.migrate();

  return NextResponse.json({ success: true });
}

function handleRekey(currentPassphrase: string, newPassphrase: string) {
  if (!isUnlocked()) {
    resetDb();
    initializeConnection(currentPassphrase);
  }

  const config = readConfig();
  const newSalt = generateSalt();
  const newHexKey = deriveKey(newPassphrase, newSalt);

  const sqlite = getConnection();
  sqlite.pragma(`rekey = "x'${newHexKey}'"`);

  writeConfig({
    ...config,
    salt: newSalt.toString("hex"),
  });

  resetDb();
  closeConnection();
  initializeConnection(newPassphrase);

  return NextResponse.json({ success: true });
}
