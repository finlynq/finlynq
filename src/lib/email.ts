/**
 * Email Service Abstraction (Phase 6: NS-36)
 *
 * Provides a pluggable email transport for the managed edition.
 * Supports SMTP (via nodemailer) or a console transport for development.
 *
 * Environment variables:
 *  - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS — SMTP credentials
 *  - EMAIL_FROM — sender address (default: noreply@finlynq.com)
 *  - APP_URL — base URL for links in emails (default: http://localhost:3000)
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Optional sender override. Defaults to EMAIL_FROM. MUST be on a
   * Resend-verified domain (finlynq.com) or Resend 403s the send — callers that
   * set this (the admin contact-inbox reply) validate the domain first.
   */
  from?: string;
  /** Optional Reply-To header. Used so a reply to our reply threads back to the mailbox address. */
  replyTo?: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

// ─── HTML escaping helper ───────────────────────────────────────────────────

/**
 * Finding M-9 (2026-05-07) — escape every user-derived interpolation in
 * HTML email templates. Currently the templates self-XSS at worst (the
 * recipient is the same user whose data is being interpolated), but the
 * helpers are reusable and any future admin / cross-account email blast
 * built on top of them would otherwise be a real injection sink. Static
 * template literals (titles, copy) are fine — only wrap string values that
 * came from the user / DB.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Console Transport (development only) ──────────────────────────────────

const consoleTransport: EmailTransport = {
  async send(message) {
    console.log(`[EMAIL] To: ${message.to}`);
    console.log(`[EMAIL] Subject: ${message.subject}`);
    console.log(`[EMAIL] Body:\n${message.text || message.html}\n`);
  },
};

// ─── SMTP Transport ─────────────────────────────────────────────────────────

function createSmtpTransport(): EmailTransport {
  // Dynamic import to avoid requiring nodemailer in self-hosted
  return {
    async send(message) {
      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: message.from || process.env.EMAIL_FROM || "noreply@finlynq.com",
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      });
    },
  };
}

// ─── Resend Transport (HTTP API) ──────────────────────────────────────────────

/**
 * Send via the Resend HTTP API. Preferred over SMTP because RESEND_API_KEY is
 * the email provider already configured for this deployment — no separate SMTP
 * credentials needed. The `from` address MUST be on a Resend-verified domain
 * (`finlynq.com` is verified, sending enabled); override the default with
 * EMAIL_FROM. Throws on a non-2xx so callers' existing error handling applies
 * (fire-and-forget for feedback notifications; surfaced for password reset).
 */
function createResendTransport(): EmailTransport {
  return {
    async send(message) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: message.from || process.env.EMAIL_FROM || "Finlynq <noreply@finlynq.com>",
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Resend API send failed (${res.status}): ${detail.slice(0, 300)}`,
        );
      }
    },
  };
}

// ─── Transport Selection ────────────────────────────────────────────────────

/**
 * Finding M-17 (2026-05-07) — never silently fall back to console-logging
 * the email body in production. The previous behavior would dump the full
 * password-reset link into stdout (and onward into log aggregation) if the
 * transport was misconfigured. We refuse to run without a real transport in
 * prod and surface the misconfiguration as an explicit error from `sendEmail`.
 *
 * Transport priority: Resend HTTP API (RESEND_API_KEY) → SMTP (SMTP_HOST) →
 * console (dev only). Resend is preferred because it's the provider already
 * provisioned for this deployment; SMTP stays supported for self-hosters who
 * wire their own mail server.
 */
function getTransport(): EmailTransport {
  if (process.env.RESEND_API_KEY) {
    return createResendTransport();
  }
  if (process.env.SMTP_HOST) {
    return createSmtpTransport();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Email transport not configured: set RESEND_API_KEY (preferred) or SMTP_HOST in production. " +
        "Refusing to fall back to console transport — that would log password reset tokens / verification links to stdout."
    );
  }
  return consoleTransport;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function sendEmail(message: EmailMessage): Promise<void> {
  const transport = getTransport();
  await transport.send(message);
}

// ─── Email Templates ────────────────────────────────────────────────────────

const APP_URL = () => process.env.APP_URL || "http://localhost:3000";

/**
 * Build the wrapper HTML. `title` is treated as untrusted text and escaped;
 * `content` is treated as ALREADY-SAFE HTML produced by the per-template
 * builders below — those builders own escaping their own user-derived
 * interpolations.
 */
function baseLayout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
    <div style="background:#18181b;padding:24px 32px">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Finlynq</h1>
    </div>
    <div style="padding:32px">
      <h2 style="margin:0 0 16px;color:#18181b;font-size:18px">${escapeHtml(title)}</h2>
      ${content}
    </div>
    <div style="padding:16px 32px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a;text-align:center">
      &copy; ${new Date().getFullYear()} Finlynq
    </div>
  </div>
</body>
</html>`;
}

/**
 * Build a CTA button. `label` is escaped (could be derived in future
 * templates); `url` is treated as a trusted URL constructed by the caller
 * from `APP_URL()` + `encodeURIComponent(token)` — but we still HTML-escape
 * it to defend against a misconfigured `APP_URL` carrying a quote character.
 */
function buttonHtml(label: string, url: string): string {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;background:#18181b;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;margin:16px 0">${escapeHtml(label)}</a>`;
}

export function emailVerificationEmail(email: string, token: string) {
  const url = `${APP_URL()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const safeUrl = escapeHtml(url);
  const html = baseLayout(
    "Verify your email",
    `<p style="color:#3f3f46;line-height:1.6">Welcome to Finlynq! Please verify your email address to get started.</p>
     ${buttonHtml("Verify Email", url)}
     <p style="color:#71717a;font-size:13px">If the button doesn't work, copy this link:<br>
     <a href="${safeUrl}" style="color:#2563eb;word-break:break-all">${safeUrl}</a></p>`
  );
  return {
    to: email,
    subject: "Verify your email — Finlynq",
    html,
    text: `Verify your email by visiting: ${url}`,
  };
}

export function passwordResetEmail(email: string, token: string) {
  const url = `${APP_URL()}/auth/reset-password?token=${encodeURIComponent(token)}`;
  const safeUrl = escapeHtml(url);
  const html = baseLayout(
    "Reset your password",
    `<p style="color:#3f3f46;line-height:1.6">We received a request to reset your password. Click below to choose a new one.</p>
     ${buttonHtml("Reset Password", url)}
     <p style="color:#71717a;font-size:13px">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
     <p style="color:#71717a;font-size:13px">If the button doesn't work:<br>
     <a href="${safeUrl}" style="color:#2563eb;word-break:break-all">${safeUrl}</a></p>`
  );
  return {
    to: email,
    subject: "Password reset — Finlynq",
    html,
    text: `Reset your password by visiting: ${url}`,
  };
}

export function welcomeEmail(email: string, displayName?: string) {
  const rawName = displayName || "there";
  const safeName = escapeHtml(rawName);
  const dashboardUrl = `${APP_URL()}/dashboard`;
  const apiDocsUrl = `${APP_URL()}/api-docs`;
  const html = baseLayout(
    `Welcome, ${rawName}!`,
    `<p style="color:#3f3f46;line-height:1.6">Your account is all set. Here's how to get the most out of Finlynq:</p>
     <ul style="color:#3f3f46;line-height:1.8;padding-left:20px">
       <li><strong>Add your accounts</strong> — checking, savings, credit cards, investments</li>
       <li><strong>Import transactions</strong> — CSV, Excel, PDF, or forward bank emails</li>
       <li><strong>Set budgets</strong> — track spending by category each month</li>
       <li><strong>Set goals</strong> — savings targets, debt payoff, emergency fund</li>
     </ul>
     ${buttonHtml("Go to Dashboard", dashboardUrl)}
     <p style="color:#71717a;font-size:13px">Need help? Check the <a href="${escapeHtml(apiDocsUrl)}" style="color:#2563eb">API docs</a> or reach out to support.</p>`
  );
  // Greeting in subject + body + plaintext intentionally uses the raw name —
  // baseLayout escapes the title argument before interpolating into <h2>.
  // safeName is used inline elsewhere.
  void safeName;
  return {
    to: email,
    subject: `Welcome to Finlynq!`,
    html,
    text: `Welcome, ${rawName}! Get started at ${dashboardUrl}`,
  };
}

export function budgetAlertEmail(
  email: string,
  categoryName: string,
  percentUsed: number,
  budgetAmount: number,
  spentAmount: number,
  currency: string
) {
  const exceeded = percentUsed >= 100;
  const title = exceeded
    ? `Budget exceeded: ${categoryName}`
    : `Budget warning: ${categoryName}`;
  const safeCategory = escapeHtml(categoryName);
  const safeCurrency = escapeHtml(currency);
  const budgetsUrl = `${APP_URL()}/budgets`;
  const html = baseLayout(
    title,
    `<p style="color:#3f3f46;line-height:1.6">
       Your <strong>${safeCategory}</strong> budget is at <strong>${Math.round(percentUsed)}%</strong>.
     </p>
     <div style="background:#fafafa;border-radius:6px;padding:16px;margin:16px 0">
       <p style="margin:0;color:#3f3f46"><strong>Budget:</strong> ${safeCurrency} ${budgetAmount.toFixed(2)}</p>
       <p style="margin:8px 0 0;color:${exceeded ? "#dc2626" : "#f59e0b"}"><strong>Spent:</strong> ${safeCurrency} ${spentAmount.toFixed(2)}</p>
     </div>
     ${buttonHtml("View Budgets", budgetsUrl)}
     <p style="color:#71717a;font-size:13px">You can manage notification preferences in your settings.</p>`
  );
  return {
    to: email,
    subject: `${title} — Finlynq`,
    html,
    text: `${title}: ${currency} ${spentAmount.toFixed(2)} of ${currency} ${budgetAmount.toFixed(2)} (${Math.round(percentUsed)}%)`,
  };
}

/**
 * Maintainer notification for a NEW in-app feedback submission. Sent TO the
 * admin recipient(s) resolved by the caller (admin user email from the DB —
 * never a hardcoded address), NOT the submitting user. Every user-derived
 * field is escaped (the body is rendered as HTML). Best-effort: callers
 * fire-and-forget this so a missing SMTP config never blocks the feedback
 * submit — the DB row is the source of truth.
 */
export function feedbackNotificationEmail(opts: {
  to: string;
  feedbackType: string;
  message: string;
  userId: string;
  userLabel?: string | null; // username or email, for the maintainer's context
  pageUrl?: string | null;
  appVersion?: string | null;
}): EmailMessage {
  const to = opts.to;
  const safeType = escapeHtml(opts.feedbackType);
  const safeMessage = escapeHtml(opts.message).replace(/\n/g, "<br>");
  const safeUser = escapeHtml(opts.userLabel || opts.userId);
  const safePage = opts.pageUrl ? escapeHtml(opts.pageUrl) : "—";
  const safeVersion = opts.appVersion ? escapeHtml(opts.appVersion) : "web";
  const html = baseLayout(
    `New ${safeType} feedback`,
    `<table style="width:100%;border-collapse:collapse;color:#3f3f46;font-size:14px;margin-bottom:16px">
       <tr><td style="padding:4px 0;color:#71717a;width:90px">Type</td><td style="padding:4px 0"><strong>${safeType}</strong></td></tr>
       <tr><td style="padding:4px 0;color:#71717a">From</td><td style="padding:4px 0">${safeUser}</td></tr>
       <tr><td style="padding:4px 0;color:#71717a">Page</td><td style="padding:4px 0">${safePage}</td></tr>
       <tr><td style="padding:4px 0;color:#71717a">Source</td><td style="padding:4px 0">${safeVersion}</td></tr>
     </table>
     <div style="background:#fafafa;border-radius:6px;padding:16px;line-height:1.6;white-space:pre-wrap">${safeMessage}</div>
     <p style="color:#71717a;font-size:13px;margin-top:16px">Review at ${escapeHtml(APP_URL())}/admin/feedback</p>`,
  );
  return {
    to,
    subject: `[Finlynq feedback] ${opts.feedbackType}`,
    html,
    text: `New ${opts.feedbackType} feedback from ${opts.userLabel || opts.userId} (page: ${opts.pageUrl || "—"}):\n\n${opts.message}`,
  };
}

/**
 * Maintainer notification for a NEW user signup. Sent TO the admin
 * recipient(s) resolved by the caller (admin user email from the DB ∪ the
 * operator override — never a hardcoded address), NOT the new user. Lets the
 * maintainer monitor growth without logging into /admin. Every user-derived
 * field is escaped (rendered as HTML). Best-effort: callers fire-and-forget so
 * a missing SMTP config never blocks (or 500s) the signup.
 */
export function newSignupNotificationEmail(opts: {
  to: string;
  userId: string;
  username: string;
  email?: string | null;
  totalUsers?: number | null;
}): EmailMessage {
  const to = opts.to;
  const safeUsername = escapeHtml(opts.username);
  const safeEmail = opts.email ? escapeHtml(opts.email) : "— (no recovery email)";
  const safeTotal =
    typeof opts.totalUsers === "number" ? String(opts.totalUsers) : "—";
  const html = baseLayout(
    `New signup: ${safeUsername}`,
    `<table style="width:100%;border-collapse:collapse;color:#3f3f46;font-size:14px;margin-bottom:16px">
       <tr><td style="padding:4px 0;color:#71717a;width:110px">Username</td><td style="padding:4px 0"><strong>${safeUsername}</strong></td></tr>
       <tr><td style="padding:4px 0;color:#71717a">Email</td><td style="padding:4px 0">${safeEmail}</td></tr>
       <tr><td style="padding:4px 0;color:#71717a">Total users</td><td style="padding:4px 0"><strong>${safeTotal}</strong></td></tr>
     </table>
     <p style="color:#71717a;font-size:13px;margin-top:16px">Review at ${escapeHtml(APP_URL())}/admin</p>`,
  );
  return {
    to,
    subject: `[Finlynq] New signup: ${opts.username}`,
    html,
    text: `New signup: ${opts.username} (${opts.email || "no email"}). Total users: ${
      typeof opts.totalUsers === "number" ? opts.totalUsers : "—"
    }.`,
  };
}

/**
 * Maintainer notification for a user REPLY on an existing feedback thread.
 * Same routing + best-effort contract as feedbackNotificationEmail: sent TO
 * the admin recipient(s) resolved by the caller (never hardcoded). The reply
 * body is user-derived and rendered as HTML, so it is escaped.
 */
export function feedbackReplyNotificationEmail(opts: {
  to: string;
  feedbackId: number;
  feedbackType?: string | null;
  body: string;
  userId: string;
  userLabel?: string | null;
}): EmailMessage {
  const to = opts.to;
  const safeType = escapeHtml(opts.feedbackType || "feedback");
  const safeBody = escapeHtml(opts.body).replace(/\n/g, "<br>");
  const safeUser = escapeHtml(opts.userLabel || opts.userId);
  const reviewUrl = `${APP_URL()}/admin/feedback`;
  const html = baseLayout(
    `New reply on ${safeType} feedback`,
    `<table style="width:100%;border-collapse:collapse;color:#3f3f46;font-size:14px;margin-bottom:16px">
       <tr><td style="padding:4px 0;color:#71717a;width:90px">Thread</td><td style="padding:4px 0"><strong>#${opts.feedbackId}</strong> (${safeType})</td></tr>
       <tr><td style="padding:4px 0;color:#71717a">From</td><td style="padding:4px 0">${safeUser}</td></tr>
     </table>
     <div style="background:#fafafa;border-radius:6px;padding:16px;line-height:1.6;white-space:pre-wrap">${safeBody}</div>
     <p style="color:#71717a;font-size:13px;margin-top:16px">Review at ${escapeHtml(reviewUrl)}</p>`,
  );
  return {
    to,
    subject: `[Finlynq feedback] reply on #${opts.feedbackId}`,
    html,
    text: `New reply on feedback #${opts.feedbackId} (${opts.feedbackType || "feedback"}) from ${opts.userLabel || opts.userId}:\n\n${opts.body}`,
  };
}

/**
 * Admin reply to a contact-inbox email (/admin/inbox). This is a person-to-
 * person reply from the maintainer to an external sender, so it deliberately
 * does NOT use the marketing `baseLayout` (dark header / footer) — it renders
 * as a plain, professional email. The admin's reply body + the (optional)
 * quoted original are user-derived → escaped. The caller sets `from` (the
 * verified mailbox address, e.g. "Finlynq <info@finlynq.com>") + `replyTo`.
 */
export function contactReplyEmail(opts: {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  replyBody: string;
  original?: {
    fromAddress: string;
    receivedAt?: string | null;
    bodyText?: string | null;
  };
}): EmailMessage {
  const safeReply = escapeHtml(opts.replyBody).replace(/\n/g, "<br>");

  let quotedHtml = "";
  let quotedText = "";
  if (opts.original) {
    const when = opts.original.receivedAt
      ? new Date(opts.original.receivedAt).toLocaleString()
      : "earlier";
    const safeWhen = escapeHtml(when);
    const safeFrom = escapeHtml(opts.original.fromAddress);
    const origBody = (opts.original.bodyText || "").trim();
    const safeOrigBody = escapeHtml(origBody).replace(/\n/g, "<br>");
    quotedHtml = `
      <div style="margin-top:24px;padding-left:12px;border-left:3px solid #e4e4e7;color:#71717a;font-size:13px;line-height:1.6">
        <p style="margin:0 0 8px">On ${safeWhen}, ${safeFrom} wrote:</p>
        ${safeOrigBody ? `<div style="white-space:pre-wrap">${safeOrigBody}</div>` : "<em>(no message body)</em>"}
      </div>`;
    quotedText = `\n\n---\nOn ${when}, ${opts.original.fromAddress} wrote:\n${
      origBody
        ? origBody
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n")
        : "> (no message body)"
    }`;
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;font-size:14px;line-height:1.6">
  <div style="max-width:600px;margin:0 auto">
    <div style="white-space:pre-wrap">${safeReply}</div>
    ${quotedHtml}
  </div>
</body>
</html>`;

  return {
    to: opts.to,
    from: opts.from,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    subject: opts.subject,
    html,
    text: `${opts.replyBody}${quotedText}`,
  };
}
