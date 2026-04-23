/**
 * Bounce helper for the `trash` category.
 *
 * When an email arrives at a finlynq.com address that doesn't match a user,
 * we store it in incoming_emails.trash (24h TTL) AND optionally send a
 * bounce back to the sender telling them the mailbox doesn't exist.
 *
 * Sends are gated on:
 *   - RESEND_API_KEY being set in env
 *   - The original message passing SPF AND DKIM (per Resend's auth-verdict
 *     fields). We never bounce to unauthenticated senders because that
 *     makes us a backscatter source — spammers forge From: addresses, and
 *     bouncing to those forged addresses blasts innocent bystanders.
 *
 * If either gate fails, we silently drop the bounce. The user-facing
 * behavior is unchanged — the attacker/typo still sees a 200 from the
 * webhook, and gets a bounce only when their setup is legit.
 */

export interface BounceInput {
  toAddress: string;       // the address that doesn't exist (the original `to`)
  fromAddress: string;     // the sender we'll reply to
  subject: string | null;  // original subject — used for "Re: …" on the bounce
  authVerdict: {
    spf?: string | null;
    dkim?: string | null;
    dmarc?: string | null;
  };
}

const BOUNCE_FROM_DEFAULT = "mailer-daemon@finlynq.com";

function isPass(v: string | null | undefined): boolean {
  if (!v) return false;
  return v.toLowerCase() === "pass";
}

/**
 * Fire-and-forget bounce send. Returns true if we actually dispatched, false
 * if we silently dropped it. Never throws — the caller is on the hot webhook
 * path and shouldn't care about bounce failures.
 */
export async function sendBounceIfAuthenticated(input: BounceInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  // Require BOTH SPF and DKIM to pass before bouncing. DMARC alone isn't
  // enough because a domain may publish `p=none` and still be legit; SPF
  // + DKIM pass means the From: header is verifiable.
  if (!isPass(input.authVerdict.spf) || !isPass(input.authVerdict.dkim)) {
    return false;
  }

  const bounceFrom = process.env.BOUNCE_FROM || BOUNCE_FROM_DEFAULT;
  const subject = input.subject
    ? `Undelivered mail: ${input.subject}`
    : "Undelivered mail";

  const body = [
    `Your message to ${input.toAddress} could not be delivered.`,
    ``,
    `This address does not exist on finlynq.com.`,
    ``,
    `If you meant to send this to your Finlynq import address, check the`,
    `address in Finlynq → Import → Email Import. The address is unique`,
    `to your account and looks like import-<8chars>@finlynq.com.`,
    ``,
    `-- Finlynq Mail Server`,
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Finlynq Mail Server <${bounceFrom}>`,
        to: [input.fromAddress],
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[email-bounce] Resend send failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[email-bounce] send threw", e);
    return false;
  }
}
