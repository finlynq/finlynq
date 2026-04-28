/**
 * Background cleanup for MCP uploads.
 *
 * Deletes expired rows from `mcp_uploads` and unlinks the corresponding
 * files on disk. The `instrumentation.ts` bootstrap schedules this on a
 * 30-minute interval once the PostgresAdapter is ready.
 *
 * Kept dead simple — no external cron, no job queue. If the node process
 * dies, the next restart picks up any backlog. Storage blobs never outlive
 * their DB row by more than the interval.
 */

import fs from "fs/promises";
import { db, schema } from "@/db";
import { lt } from "drizzle-orm";

/**
 * Delete MCP upload rows past their expiresAt and unlink the files on disk.
 * Returns the number of rows deleted. Best-effort — errors on individual
 * file unlinks are swallowed (the file may already be gone).
 */
export async function cleanupExpiredUploads(): Promise<{ deleted: number; errors: number }> {
  const now = new Date();
  // Snapshot which rows we're about to delete so we know which blobs to unlink.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expired = (await db
    .select({
      id: schema.mcpUploads.id,
      storagePath: schema.mcpUploads.storagePath,
    })
    .from(schema.mcpUploads)
    .where(lt(schema.mcpUploads.expiresAt, now))) as Array<{ id: string; storagePath: string }>;

  if (expired.length === 0) return { deleted: 0, errors: 0 };

  let errors = 0;
  for (const row of expired) {
    try {
      await fs.unlink(row.storagePath);
    } catch {
      // File may already be gone (cancel_import, manual cleanup). Count but
      // don't fail the sweep — the DB row delete is the authoritative action.
      errors++;
    }
  }

  await db.delete(schema.mcpUploads).where(lt(schema.mcpUploads.expiresAt, now));
  return { deleted: expired.length, errors };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the cleanup interval. Safe to call multiple times — second call is a
 * no-op. Interval: 30 minutes.
 */
export function startUploadCleanupTimer(): void {
  if (timer) return;
  const THIRTY_MIN = 30 * 60 * 1000;
  timer = setInterval(() => {
    cleanupExpiredUploads().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[mcp-upload-cleanup] sweep failed:", err);
    });
  }, THIRTY_MIN);
  // Don't keep the node process alive purely for this timer.
  if (timer.unref) timer.unref();
}

/** Stop the cleanup interval. For tests. */
export function stopUploadCleanupTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
