# Email Authentication: SPF Record + DMARC p=reject Rollout Plan

**FINLYNQ-158 — DNS/ops, no code. Authored 2026-06-14.**

---

## Current state (as of 2026-06-14)

| Record | Current value |
|---|---|
| `finlynq.com` TXT | `google-site-verification=…` only — **no SPF record** |
| `_dmarc.finlynq.com` | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` |
| `finlynq.com` MX | `10 inbound-smtp.us-east-1.amazonaws.com` (inbound via AWS SES, us-east-1) |
| `mail.finlynq.com` TXT | none |

DMARC is already live at `p=quarantine` with RUA aggregate reports flowing to `dmarc_rua@onsecureserver.net`
(GoDaddy/Secureserver — the likely DNS host). The absence of an SPF record means every outbound email
from `@finlynq.com` fails the SPF check, which weakens DMARC alignment and will cause deliverability
problems once DMARC is tightened to `p=reject`.

---

## Outbound senders inventory

### Sender 1 — outbound transactional mail (primary outbound path)

**File:** `src/lib/email.ts`

The app sends transactional mail (email verification, password reset, welcome, budget alerts, admin
feedback notifications, in-app password/email-change notifications). Transport selection in
`getTransport()` is, in priority order: **Resend HTTP API** (when `RESEND_API_KEY` is set — the
provisioned provider, verified sending domain `finlynq.com`), then **nodemailer SMTP** (`SMTP_HOST` /
`SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`, for self-hosters who run their own mail server), then the
dev-only console transport. Production refuses to start a send with neither configured. The `EMAIL_FROM`
environment variable controls the `From:` address (default `Finlynq <noreply@finlynq.com>`).
Feedback notifications are addressed (`To:`) to the admin account email(s) resolved from the DB
(`users.role='admin'`), with the **optional** `FEEDBACK_EMAIL` as an extra recipient — there is no
hardcoded fallback address (see `src/lib/feedback/notify.ts`).

Because Resend is the active transport, SPF/DKIM/DMARC for the `From:` domain must cover **Resend**
(SPF `include:_spf.resend.com`, plus the Resend-issued DKIM CNAMEs) — the SMTP/SES notes below apply
only to a self-hosted SMTP deployment.

The **SMTP provider is operator-configured** — it is NOT hardcoded to a specific service. The most likely
configuration for the hosted deployment is Amazon SES over SMTP (endpoint
`email-smtp.<region>.amazonaws.com`, port 587 or 465), since the MX record already points at SES
(`inbound-smtp.us-east-1.amazonaws.com`). However, the operator should confirm this before publishing
SPF: if a different SMTP relay is in use (e.g. a self-hosted Postfix, SendGrid, or Mailgun), its
mechanism must also appear in the SPF record.

**Action for operator:** confirm the value of `SMTP_HOST` in the production `.env` / systemd unit.
If it is an AWS SES SMTP endpoint, `include:amazonses.com` covers it. If it is any other service,
add the appropriate `include:` or `ip4:` mechanism.

### Sender 2 — Resend API (bounce notifications only)

**File:** `src/lib/email-import/bounce.ts`

When an inbound email arrives at an import address that does not match any user, and `RESEND_API_KEY` is
set, the app fires a bounce from `mailer-daemon@finlynq.com` (or `BOUNCE_FROM`) via the Resend REST API
(`https://api.resend.com/emails`). This is gated on the original sender passing both SPF and DKIM
(to avoid backscatter) and is best-effort / fire-and-forget.

Resend publishes its outbound SPF include at `_spf.resend.com`. If `RESEND_API_KEY` is in use in
production, this mechanism must be added to the SPF record.

**Action for operator:** confirm whether `RESEND_API_KEY` is set in production. If yes, add
`include:_spf.resend.com` to the SPF record.

### What is NOT an outbound sender

- **DevManager push relay (`INBOUND_EMAIL_PROVIDER=self-smtp`)** — INBOUND only. DevManager pushes
  emails TO the app's webhook. It sends nothing from `@finlynq.com`.
- **Resend Inbound (`INBOUND_EMAIL_PROVIDER=resend`)** — INBOUND only. Resend's inbound route delivers
  email TO the app's webhook endpoint. No outbound mail originates from the app via this path.
- **AWS SES inbound (MX)** — receives mail for `mail.finlynq.com` / `finlynq.com`. Not an outbound
  sender of `@finlynq.com` mail.

---

## SPF record to publish

### Minimum record (SES-only SMTP, no Resend bounce)

```
v=spf1 include:amazonses.com ~all
```

### Recommended record (SES SMTP + Resend bounce emails)

```
v=spf1 include:amazonses.com include:_spf.resend.com ~all
```

**Where to publish:** a DNS TXT record on the root domain **`finlynq.com`** (not a subdomain).

**Why `~all` (softfail) at launch:** keep softfail until DMARC RUA reports confirm alignment is
stable for all legitimate sources. Changing directly to `-all` risks hard-rejecting legitimate mail
if a sender was missed. Promote to `-all` after a monitoring window (see DMARC plan below).

**DNS lookup budget:** the SPF spec allows a maximum of 10 DNS lookups per evaluation. The two
`include:` mechanisms above each resolve to a small number of lookups; the combined record stays
well within the limit.

**`mail.finlynq.com` subdomain:** the import email domain (`IMPORT_EMAIL_DOMAIN=mail.finlynq.com`)
is currently inbound-only (SES MX). No application code sends outbound mail from `@mail.finlynq.com`
addresses. A subdomain SPF record is only needed if mail is sent FROM that subdomain. No action
required for `mail.finlynq.com` at this time; revisit if a future inbound-reply or bounce path
originates from `@mail.finlynq.com`.

---

## DKIM status

AWS SES requires CNAME-based DKIM verification for any domain it sends mail on behalf of. Since the
MX record points at SES, DKIM should already be configured. Confirm by running:

```
dig CNAME <selector>._domainkey.finlynq.com
```

Replace `<selector>` with the selector from the SES console (usually something like
`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx._domainkey.finlynq.com`). A valid CNAME response pointing at
`dkim.amazonses.com` confirms DKIM is active.

If Resend is used for bounce sends, Resend also requires a DNS CNAME for DKIM on the sending domain.
Check the Resend dashboard under "Domains" to confirm `finlynq.com` is verified there.

**Without DKIM alignment, tightening DMARC to `p=reject` will reject legitimate mail.** Confirm
DKIM CNAMEs are present and resolving before proceeding to `p=reject`.

---

## DMARC p=reject rollout plan

### Current state

`_dmarc.finlynq.com` is already at `p=quarantine` with relaxed alignment (`adkim=r; aspf=r`) and
aggregate reports flowing to `dmarc_rua@onsecureserver.net`. This is the correct starting point.

### Staged migration to p=reject

**Phase 1 — Publish SPF (immediate)**

Publish the SPF TXT record on `finlynq.com` (see record above). This is the blocker for everything
that follows: without SPF, DMARC alignment fails on the SPF leg for all outbound mail regardless of
DKIM.

**Phase 2 — Monitor (4–8 weeks after SPF is live)**

Read the DMARC RUA aggregate reports delivered to `dmarc_rua@onsecureserver.net`. Look for:

- `spf="pass"` on all legitimate sources (confirms SPF record is complete).
- `dkim="pass"` on all legitimate sources (confirms DKIM CNAMEs are resolving).
- `dmarc="pass"` (either leg passing with aligned domain = green).
- No unexpected sources in the aggregate data (no shadow senders missed from the inventory).

A free DMARC report aggregator (e.g. `dmarcian.com`, `postmark.com/dmarc/`) makes reading the XML
reports significantly easier.

**Gating condition:** wait until RUA reports show consistent SPF+DKIM alignment (`dmarc="pass"`) for
all legitimate sources across a representative window (ideally covering a full billing/notification
cycle). There should be no unexplained DMARC failures from the sending IP ranges.

**Phase 3 — Tighten SPF to `-all` (optional, before or concurrent with p=reject)**

Once you are confident the sender inventory is complete, change `~all` (softfail) to `-all` (hardfail).
This has no user-visible effect while DMARC is at `p=reject` (DMARC already handles the reject
disposition), but it removes the softfail signal that some receivers treat permissively.

**Phase 4 — Flip DMARC to p=reject**

Update `_dmarc.finlynq.com` to:

```
v=DMARC1; p=reject; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;
```

The only change is `p=quarantine` → `p=reject`. All other fields (`adkim`, `aspf`, `rua`) remain
the same. Mail that fails DMARC will now be rejected at the receiving server rather than
quarantined; spoofed `@finlynq.com` mail can no longer reach users' inboxes.

**Rollback:** if deliverability issues appear after the flip, revert to `p=quarantine` immediately
by updating the DNS TXT record. DNS TTL is typically 300–3600 s; changes propagate within minutes
to an hour.

**Phase 5 — Add `ruf=` forensic reports (optional)**

If available from the DNS host, add `ruf=mailto:<address>` for per-failure forensic reports. These
give message-level detail for individual DMARC failures. Note that `ruf` support by receivers is
declining (privacy concerns); `rua` aggregate reports are sufficient for most purposes.

---

## Operator action checklist

- [ ] Confirm `SMTP_HOST` in production `.env` / systemd unit. If it is an AWS SES SMTP endpoint,
  `include:amazonses.com` is correct. If another provider, identify and add its SPF include.
- [ ] Confirm whether `RESEND_API_KEY` is set in production. If yes, add `include:_spf.resend.com`
  to the SPF record.
- [ ] **Publish SPF TXT record on `finlynq.com`** (copy-paste the exact string from the section
  above into the DNS host — likely GoDaddy/Secureserver based on the DMARC RUA address).
- [ ] Confirm DKIM CNAME(s) for SES are present:
  `dig CNAME <selector>._domainkey.finlynq.com` returns a CNAME to `dkim.amazonses.com`.
- [ ] If Resend bounces are active: confirm `finlynq.com` is verified in the Resend dashboard.
- [ ] Monitor RUA aggregate reports at `dmarc_rua@onsecureserver.net` for 4–8 weeks.
- [ ] Once alignment is confirmed: update `_dmarc.finlynq.com` to `p=reject`.
- [ ] (Optional) update SPF `~all` to `-all` concurrent with or after `p=reject`.

---

## Quick copy-paste: SPF record to publish now

**DNS record type:** TXT  
**Name/Host:** `@` (or `finlynq.com`)  
**Value (SES + Resend):**

```
v=spf1 include:amazonses.com include:_spf.resend.com ~all
```

**Value (SES only, if `RESEND_API_KEY` is not set in production):**

```
v=spf1 include:amazonses.com ~all
```
