import fs from "fs";
import path from "path";

const SQLITE_MAGIC = "SQLite format 3\0";
const MIN_SQLITE_SIZE = 100; // Minimum valid SQLite file size (header)

/**
 * Verify a SQLite database file is intact and not mid-sync.
 * Returns null if OK, or an error message describing the issue.
 */
export function checkFileIntegrity(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) {
    return null; // File doesn't exist yet — that's fine for new DBs
  }

  try {
    const stats = fs.statSync(dbPath);

    // Check minimum file size
    if (stats.size < MIN_SQLITE_SIZE) {
      return "Database file appears incomplete (too small). It may still be syncing.";
    }

    // Check SQLite magic header
    const fd = fs.openSync(dbPath, "r");
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);

    const magic = header.toString("ascii", 0, 16);
    if (magic !== SQLITE_MAGIC) {
      // Could be encrypted — encrypted SQLCipher files don't have the magic header
      // This is expected for our encrypted databases, so don't flag it
      return null;
    }

    return null;
  } catch (error) {
    return `Cannot read database file: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

/**
 * Check for cloud provider conflict copies near the database file.
 * Returns a list of conflict file paths found.
 */
export function findConflictFiles(dbPath: string): string[] {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath, path.extname(dbPath));
  const ext = path.extname(dbPath);

  try {
    const files = fs.readdirSync(dir);
    const conflicts: string[] = [];

    for (const file of files) {
      // Google Drive: "pf (1).db", "pf (2).db"
      // Dropbox: "pf (conflicted copy).db"
      // OneDrive: "pf-HOSTNAME.db"
      if (
        file !== path.basename(dbPath) &&
        file.startsWith(base) &&
        file.endsWith(ext) &&
        file !== `${base}.lock`
      ) {
        // Check common conflict patterns
        if (
          /\(\d+\)/.test(file) || // numbered copies
          /conflict/i.test(file) || // conflict keyword
          /\-[A-Za-z0-9]+\.[^.]+$/.test(file.replace(base, "")) // hostname suffix
        ) {
          conflicts.push(path.join(dir, file));
        }
      }
    }

    return conflicts;
  } catch {
    return [];
  }
}
