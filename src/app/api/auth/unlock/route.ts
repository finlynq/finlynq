import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  initializeConnection,
  isUnlocked,
  closeConnection,
  getConnection,
  getDialect,
  DEFAULT_USER_ID,
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
import { createSessionToken, verifySessionToken, AUTH_COOKIE } from "@/lib/auth";

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

/** Set the pf_session cookie on a response for self-hosted mode. */
async function setSessionCookie(response: NextResponse): Promise<NextResponse> {
  const token = await createSessionToken(DEFAULT_USER_ID, "self-hosted", false);
  response.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24, // 24 hours
    path: "/",
  });
  return response;
}

export async function GET(request: NextRequest) {
  const dialect = getDialect();

  // In managed mode, check for a valid account session
  if (dialect === "postgres") {
    let clientUnlocked = false;
    const token = request.cookies.get(AUTH_COOKIE)?.value;
    if (token) {
      const payload = await verifySessionToken(token);
      clientUnlocked = payload !== null;
    }
    return NextResponse.json({
      unlocked: clientUnlocked,
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

  // DB may be globally unlocked, but this client is only "unlocked"
  // if they have a valid session cookie.
  let clientUnlocked = false;
  if (isUnlocked()) {
    const token = request.cookies.get(AUTH_COOKIE)?.value;
    if (token) {
      const payload = await verifySessionToken(token);
      clientUnlocked = payload !== null && payload.sub === DEFAULT_USER_ID;
    }
  }

  return NextResponse.json({
    unlocked: clientUnlocked,
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

async function handleUnlock(passphrase: string) {
  resetDb();
  initializeConnection(passphrase);
  const response = NextResponse.json({ success: true });
  return setSessionCookie(response);
}

function handleLock() {
  resetDb();
  closeConnection();
  const response = NextResponse.json({ success: true });
  // Clear session cookie on lock
  response.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}

async function handleSetup(
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

  const response = NextResponse.json({ success: true });
  return setSessionCookie(response);
}

async function handleRekey(currentPassphrase: string, newPassphrase: string) {
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

  const response = NextResponse.json({ success: true });
  return setSessionCookie(response);
}
