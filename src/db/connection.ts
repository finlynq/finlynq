import Database from "better-sqlite3-multiple-ciphers";
import type BetterSqlite3 from "better-sqlite3";
import { deriveKey } from "@shared/crypto";
import { readConfig, resolveDbPath } from "@shared/config";
import { acquireLock, releaseLock, isReadOnly as syncIsReadOnly } from "./sync";
import { checkFileIntegrity } from "./sync-checks";

// Persist connection state across HMR in development
const g = globalThis as typeof globalThis & {
  __pfConnection?: BetterSqlite3.Database | null;
  __pfMode?: "local" | "cloud";
  __pfDbPath?: string;
};

function getConn(): BetterSqlite3.Database | null {
  return g.__pfConnection ?? null;
}
function setConn(c: BetterSqlite3.Database | null) {
  g.__pfConnection = c;
}
function getStoredMode(): "local" | "cloud" {
  return g.__pfMode ?? "local";
}
function setStoredMode(m: "local" | "cloud") {
  g.__pfMode = m;
}
function getStoredDbPath(): string {
  return g.__pfDbPath ?? "";
}
function setStoredDbPath(p: string) {
  g.__pfDbPath = p;
}

export class DatabaseLockedError extends Error {
  constructor() {
    super("Database is locked. Enter your passphrase to unlock.");
    this.name = "DatabaseLockedError";
  }
}

export function initializeConnection(
  passphrase: string,
  dbPath?: string,
  mode?: "local" | "cloud"
): void {
  if (getConn()) {
    closeConnection();
  }

  const config = readConfig();
  const resolvedPath = dbPath || resolveDbPath(config);
  setStoredMode(mode || config.mode);
  setStoredDbPath(resolvedPath);
  const salt = Buffer.from(config.salt, "hex");
  const hexKey = deriveKey(passphrase, salt);

  // In cloud mode, check file integrity and acquire lock
  if (getStoredMode() === "cloud") {
    const integrityError = checkFileIntegrity(resolvedPath);
    if (integrityError) {
      throw new Error(integrityError);
    }
    acquireLock(resolvedPath);
  }

  // Open DB — read-only if another device holds the lock
  const openReadOnly = getStoredMode() === "cloud" && syncIsReadOnly();
  const sqlite = new (Database as unknown as typeof BetterSqlite3)(
    resolvedPath,
    openReadOnly ? { readonly: true } : undefined
  );

  // Set encryption key — MUST be before any other operations
  sqlite.pragma(`key = "x'${hexKey}'"`);

  // Validate passphrase by reading the schema
  try {
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch {
    sqlite.close();
    throw new Error("Invalid passphrase. Could not unlock the database.");
  }

  // Set journal mode based on operating mode (only if we have write access)
  if (!openReadOnly) {
    if (getStoredMode() === "cloud") {
      // Rollback journal (single file) for cloud drive compatibility
      sqlite.pragma("journal_mode = DELETE");
    } else {
      sqlite.pragma("journal_mode = WAL");
    }
  }

  sqlite.pragma("foreign_keys = ON");

  setConn(sqlite);
}

export function getConnection(): BetterSqlite3.Database {
  const conn = getConn();
  if (!conn) {
    throw new DatabaseLockedError();
  }
  return conn;
}

export function isUnlocked(): boolean {
  return getConn() !== null;
}

export function getMode(): "local" | "cloud" {
  return getStoredMode();
}

export function getDbPath(): string {
  return getStoredDbPath();
}

export function isCloudReadOnly(): boolean {
  return getStoredMode() === "cloud" && syncIsReadOnly();
}

export function closeConnection(): void {
  const conn = getConn();
  if (conn) {
    try {
      conn.close();
    } catch {
      // ignore close errors
    }
    setConn(null);
  }

  // Release lock in cloud mode
  if (getStoredMode() === "cloud" && getStoredDbPath()) {
    releaseLock(getStoredDbPath());
  }
}
