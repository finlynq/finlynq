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
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

// ─── Console Transport (development) ────────────────────────────────────────

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
        from: process.env.EMAIL_FROM || "noreply@finlynq.com",
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    },
  };
}

// ─── Transport Selection ────────────────────────────────────────────────────

function getTransport(): EmailTransport {
  if (process.env.SMTP_HOST) {
    return createSmtpTransport();
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
      <h2 style="margin:0 0 16px;color:#18181b;font-size:18px">${title}</h2>
      ${content}
    </div>
    <div style="padding:16px 32px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a;text-align:center">
      &copy; ${new Date().getFullYear()} Finlynq
    </div>
  </div>
</body>
</html>`;
}

function buttonHtml(label: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;padding:12px 24px;background:#18181b;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;margin:16px 0">${label}</a>`;
}

export function emailVerificationEmail(email: string, token: string) {
  const url = `${APP_URL()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const html = baseLayout(
    "Verify your email",
    `<p style="color:#3f3f46;line-height:1.6">Welcome to Finlynq! Please verify your email address to get started.</p>
     ${buttonHtml("Verify Email", url)}
     <p style="color:#71717a;font-size:13px">If the button doesn't work, copy this link:<br>
     <a href="${url}" style="color:#2563eb;word-break:break-all">${url}</a></p>`
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
  const html = baseLayout(
    "Reset your password",
    `<p style="color:#3f3f46;line-height:1.6">We received a request to reset your password. Click below to choose a new one.</p>
     ${buttonHtml("Reset Password", url)}
     <p style="color:#71717a;font-size:13px">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
     <p style="color:#71717a;font-size:13px">If the button doesn't work:<br>
     <a href="${url}" style="color:#2563eb;word-break:break-all">${url}</a></p>`
  );
  return {
    to: email,
    subject: "Password reset — Finlynq",
    html,
    text: `Reset your password by visiting: ${url}`,
  };
}

export function welcomeEmail(email: string, displayName?: string) {
  const name = displayName || "there";
  const html = baseLayout(
    `Welcome, ${name}!`,
    `<p style="color:#3f3f46;line-height:1.6">Your account is all set. Here's how to get the most out of Finlynq:</p>
     <ul style="color:#3f3f46;line-height:1.8;padding-left:20px">
       <li><strong>Add your accounts</strong> — checking, savings, credit cards, investments</li>
       <li><strong>Import transactions</strong> — CSV, Excel, PDF, or forward bank emails</li>
       <li><strong>Set budgets</strong> — track spending by category each month</li>
       <li><strong>Set goals</strong> — savings targets, debt payoff, emergency fund</li>
     </ul>
     ${buttonHtml("Go to Dashboard", `${APP_URL()}/dashboard`)}
     <p style="color:#71717a;font-size:13px">Need help? Check the <a href="${APP_URL()}/api-docs" style="color:#2563eb">API docs</a> or reach out to support.</p>`
  );
  return {
    to: email,
    subject: "Welcome to Finlynq!",
    html,
    text: `Welcome, ${name}! Get started at ${APP_URL()}/dashboard`,
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
  const html = baseLayout(
    title,
    `<p style="color:#3f3f46;line-height:1.6">
       Your <strong>${categoryName}</strong> budget is at <strong>${Math.round(percentUsed)}%</strong>.
     </p>
     <div style="background:#fafafa;border-radius:6px;padding:16px;margin:16px 0">
       <p style="margin:0;color:#3f3f46"><strong>Budget:</strong> ${currency} ${budgetAmount.toFixed(2)}</p>
       <p style="margin:8px 0 0;color:${exceeded ? "#dc2626" : "#f59e0b"}"><strong>Spent:</strong> ${currency} ${spentAmount.toFixed(2)}</p>
     </div>
     ${buttonHtml("View Budgets", `${APP_URL()}/budgets`)}
     <p style="color:#71717a;font-size:13px">You can manage notification preferences in your settings.</p>`
  );
  return {
    to: email,
    subject: `${title} — Finlynq`,
    html,
    text: `${title}: ${currency} ${spentAmount.toFixed(2)} of ${currency} ${budgetAmount.toFixed(2)} (${Math.round(percentUsed)}%)`,
  };
}
