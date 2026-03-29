import fs from "fs";
import path from "path";
import os from "os";

interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  timestamp: number;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 1 minute

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let readOnlyMode = false;

function getLockPath(dbPath: string): string {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath, path.extname(dbPath));
  return path.join(dir, `${base}.lock`);
}

function createLockInfo(): LockInfo {
  return {
    holder: `${os.hostname()}-${process.pid}`,
    hostname: os.hostname(),
    pid: process.pid,
    timestamp: Date.now(),
  };
}

export function checkLock(dbPath: string): {
  locked: boolean;
  holder?: string;
  hostname?: string;
  timestamp?: number;
  stale?: boolean;
} {
  const lockPath = getLockPath(dbPath);

  if (!fs.existsSync(lockPath)) {
    return { locked: false };
  }

  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const info: LockInfo = JSON.parse(raw);

    // Check if the lock is held by this process
    const isOurs =
      info.hostname === os.hostname() && info.pid === process.pid;
    if (isOurs) {
      return { locked: false }; // Our own lock doesn't block us
    }

    // Check if lock is stale
    const age = Date.now() - info.timestamp;
    if (age > STALE_THRESHOLD_MS) {
      return {
        locked: true,
        holder: info.holder,
        hostname: info.hostname,
        timestamp: info.timestamp,
        stale: true,
      };
    }

    return {
      locked: true,
      holder: info.holder,
      hostname: info.hostname,
      timestamp: info.timestamp,
      stale: false,
    };
  } catch {
    // Corrupt lock file — treat as stale
    return { locked: true, stale: true };
  }
}

export function acquireLock(dbPath: string): boolean {
  const lockPath = getLockPath(dbPath);
  const lockStatus = checkLock(dbPath);

  if (lockStatus.locked && !lockStatus.stale) {
    // Another device holds a valid lock
    readOnlyMode = true;
    return false;
  }

  // Write lock file
  const info = createLockInfo();
  try {
    fs.writeFileSync(lockPath, JSON.stringify(info, null, 2), "utf-8");
  } catch {
    readOnlyMode = true;
    return false;
  }

  readOnlyMode = false;

  // Start heartbeat
  startHeartbeat(dbPath);

  return true;
}

export function releaseLock(dbPath: string): void {
  stopHeartbeat();

  const lockPath = getLockPath(dbPath);
  try {
    if (fs.existsSync(lockPath)) {
      // Only delete if it's our lock
      const raw = fs.readFileSync(lockPath, "utf-8");
      const info: LockInfo = JSON.parse(raw);
      if (info.hostname === os.hostname() && info.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // Best effort cleanup
  }
}

export function forceReleaseLock(dbPath: string): void {
  stopHeartbeat();
  const lockPath = getLockPath(dbPath);
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Best effort
  }
}

export function isReadOnly(): boolean {
  return readOnlyMode;
}

function startHeartbeat(dbPath: string): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const lockPath = getLockPath(dbPath);
    try {
      const info = createLockInfo();
      fs.writeFileSync(lockPath, JSON.stringify(info, null, 2), "utf-8");
    } catch {
      // If we can't update the heartbeat, stop trying
      stopHeartbeat();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Don't block process exit
  if (heartbeatTimer && typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
    (heartbeatTimer as NodeJS.Timeout).unref();
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
