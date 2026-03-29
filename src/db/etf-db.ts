import Database from "better-sqlite3-multiple-ciphers";
import type BetterSqlite3 from "better-sqlite3";
import path from "path";

// Separate unencrypted SQLite database for ETF breakdown data.
// This is public market data shared across all clients — no encryption needed.

const g = globalThis as typeof globalThis & {
  __etfConnection?: BetterSqlite3.Database | null;
};

function getEtfDbPath(): string {
  return path.join(process.cwd(), "etf-data.db");
}

function getEtfConnection(): BetterSqlite3.Database {
  if (!g.__etfConnection) {
    const dbPath = getEtfDbPath();
    const sqlite = new (Database as unknown as typeof BetterSqlite3)(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    // Create tables on first connection
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS etf_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        total_holdings INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS etf_regions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        etf_symbol TEXT NOT NULL,
        region TEXT NOT NULL,
        weight REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS etf_sectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        etf_symbol TEXT NOT NULL,
        sector TEXT NOT NULL,
        weight REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS etf_constituents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        etf_symbol TEXT NOT NULL,
        ticker TEXT NOT NULL,
        name TEXT NOT NULL,
        weight REAL NOT NULL,
        sector TEXT NOT NULL DEFAULT 'Other',
        country TEXT NOT NULL DEFAULT 'Unknown'
      );
    `);

    g.__etfConnection = sqlite;
  }
  return g.__etfConnection;
}

// ─── Query helpers ───────────────────────────────────────────────────────────

export function getEtfInfoAll() {
  const db = getEtfConnection();
  return db.prepare("SELECT * FROM etf_info ORDER BY symbol").all() as {
    id: number;
    symbol: string;
    full_name: string;
    total_holdings: number;
    updated_at: string;
  }[];
}

export function getEtfInfoBySymbol(symbol: string) {
  const db = getEtfConnection();
  return db.prepare("SELECT * FROM etf_info WHERE symbol = ?").get(symbol) as {
    id: number;
    symbol: string;
    full_name: string;
    total_holdings: number;
    updated_at: string;
  } | undefined;
}

export function getEtfRegionsBySymbol(symbol: string) {
  const db = getEtfConnection();
  return db.prepare("SELECT region, weight FROM etf_regions WHERE etf_symbol = ?").all(symbol) as {
    region: string;
    weight: number;
  }[];
}

export function getEtfSectorsBySymbol(symbol: string) {
  const db = getEtfConnection();
  return db.prepare("SELECT sector, weight FROM etf_sectors WHERE etf_symbol = ?").all(symbol) as {
    sector: string;
    weight: number;
  }[];
}

export function getEtfConstituentsBySymbol(symbol: string) {
  const db = getEtfConnection();
  return db.prepare("SELECT ticker, name, weight, sector, country FROM etf_constituents WHERE etf_symbol = ?").all(symbol) as {
    ticker: string;
    name: string;
    weight: number;
    sector: string;
    country: string;
  }[];
}

// ─── Write helpers ───────────────────────────────────────────────────────────

export function upsertEtfInfo(symbol: string, fullName: string, totalHoldings: number) {
  const db = getEtfConnection();
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM etf_info WHERE symbol = ?").get(symbol);
  if (existing) {
    db.prepare("UPDATE etf_info SET full_name = ?, total_holdings = ?, updated_at = ? WHERE symbol = ?")
      .run(fullName, totalHoldings, now, symbol);
  } else {
    db.prepare("INSERT INTO etf_info (symbol, full_name, total_holdings, updated_at) VALUES (?, ?, ?, ?)")
      .run(symbol, fullName, totalHoldings, now);
  }
}

export function replaceEtfRegions(symbol: string, regions: Record<string, number>) {
  const db = getEtfConnection();
  db.prepare("DELETE FROM etf_regions WHERE etf_symbol = ?").run(symbol);
  const insert = db.prepare("INSERT INTO etf_regions (etf_symbol, region, weight) VALUES (?, ?, ?)");
  for (const [region, weight] of Object.entries(regions)) {
    insert.run(symbol, region, weight);
  }
}

export function replaceEtfSectors(symbol: string, sectors: Record<string, number>) {
  const db = getEtfConnection();
  db.prepare("DELETE FROM etf_sectors WHERE etf_symbol = ?").run(symbol);
  const insert = db.prepare("INSERT INTO etf_sectors (etf_symbol, sector, weight) VALUES (?, ?, ?)");
  for (const [sector, weight] of Object.entries(sectors)) {
    insert.run(symbol, sector, weight);
  }
}

export function replaceEtfConstituents(symbol: string, constituents: { ticker: string; name: string; weight: number; sector: string; country: string }[]) {
  const db = getEtfConnection();
  db.prepare("DELETE FROM etf_constituents WHERE etf_symbol = ?").run(symbol);
  const insert = db.prepare("INSERT INTO etf_constituents (etf_symbol, ticker, name, weight, sector, country) VALUES (?, ?, ?, ?, ?, ?)");
  for (const c of constituents) {
    insert.run(symbol, c.ticker, c.name, c.weight, c.sector, c.country);
  }
}

export function seedEtfFromData(
  symbol: string,
  fullName: string,
  totalHoldings: number,
  regions: Record<string, number> | null,
  sectors: Record<string, number> | null,
  constituents: { ticker: string; name: string; weight: number; sector: string; country: string }[] | null,
) {
  upsertEtfInfo(symbol, fullName, totalHoldings);
  if (regions) replaceEtfRegions(symbol, regions);
  if (sectors) replaceEtfSectors(symbol, sectors);
  if (constituents) replaceEtfConstituents(symbol, constituents);
}

export function deleteEtfData(symbol: string) {
  const db = getEtfConnection();
  db.prepare("DELETE FROM etf_constituents WHERE etf_symbol = ?").run(symbol);
  db.prepare("DELETE FROM etf_sectors WHERE etf_symbol = ?").run(symbol);
  db.prepare("DELETE FROM etf_regions WHERE etf_symbol = ?").run(symbol);
  db.prepare("DELETE FROM etf_info WHERE symbol = ?").run(symbol);
}

export function clearAllEtfData() {
  const db = getEtfConnection();
  db.exec("DELETE FROM etf_constituents; DELETE FROM etf_sectors; DELETE FROM etf_regions; DELETE FROM etf_info;");
}
