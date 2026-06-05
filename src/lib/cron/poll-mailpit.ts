/**
 * Mailpit poll-backstop cron (Epic A4).
 *
 * Mailpit does NOT retry a failed webhook. So a dropped webhook (app restart,
 * transient 5xx, network blip) would leave a received email un-ingested. Mailpit
 * RETAINS the message until we delete it, so this cron periodically lists the
 * messages still held and ingests anything the webhook missed — then deletes it.
 *
 * Idempotent with the webhook: ingest dedupes on the per-recipient key
 * (email_inbox.dedupe_key), and a message the webhook already handled was
 * deleted from Mailpit, so it won't appear in the list. A message left behind
 * by a dropped webhook is processed here on the next tick.
 *
 * Only active when INBOUND_EMAIL_PROVIDER=self-smtp (Resend self-retries, so
 * listPending() returns []). Fire-and-forget; per-message try/catch leaves a
 * failing message in Mailpit for the next tick rather than deleting it.
 */

import { getInboundProvider } from "@/lib/email-import/providers";
import { ingestInboundEmail } from "@/lib/email-import/ingest";

const POLL_LIMIT = 50;

export interface PollResult {
  processed: number;
  deleted: number;
  failed: number;
}

export async function pollMailpitBackstop(): Promise<PollResult> {
  const provider = getInboundProvider();
  if (provider.name !== "self-smtp") {
    return { processed: 0, deleted: 0, failed: 0 };
  }

  const pending = await provider.listPending(POLL_LIMIT);
  let processed = 0;
  let deleted = 0;
  let failed = 0;
  const receivedDate = new Date().toISOString().slice(0, 10);

  for (const parsed of pending) {
    try {
      await ingestInboundEmail(provider, parsed, { svixId: null, receivedDate });
      processed++;
      if (parsed.providerMessageId) {
        await provider.deleteReceived(parsed.providerMessageId);
        deleted++;
      }
    } catch (e) {
      failed++;
      // Leave the message in Mailpit (don't delete) so the next tick retries.
      console.warn("[poll-mailpit] ingest failed; leaving message", {
        id: parsed.providerMessageId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { processed, deleted, failed };
}

let timer: NodeJS.Timeout | null = null;

/** Start the 5-minute poll. No-op unless INBOUND_EMAIL_PROVIDER=self-smtp. */
export function startMailpitPollTimer(): void {
  if (timer) return;
  if ((process.env.INBOUND_EMAIL_PROVIDER || "").toLowerCase() !== "self-smtp") return;
  const INTERVAL = 5 * 60 * 1000;
  timer = setInterval(() => {
    pollMailpitBackstop().catch((err) => {
      console.error("[poll-mailpit] poll failed:", err);
    });
  }, INTERVAL);
  if (timer.unref) timer.unref();
  console.log("[instrumentation] mailpit poll-backstop cron registered (5m interval)");
}

/** Stop the poll interval. For tests. */
export function stopMailpitPollTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
