# Resend Inbound — Setup Guide

This guide walks through what you need to configure in Resend (and at your DNS provider) to turn on inbound email for Finlynq. The code is already shipped and live on prod — this is purely the external infrastructure that needs to be set up once.

**Outcome:** users can forward a bank statement email to `import-<uuid>@finlynq.com`, the message gets parsed and lands in their review queue at `/import/pending`, and random/probing addresses land in the admin inbox at `/admin/inbox`.

**Time required:** ~30 minutes active work + up to 48 hours for DNS propagation.

**What's already done (no action needed):**
- `/api/import/email-webhook` accepts Resend's JSON payload, verifies svix signatures, routes by `to` address (import / mailbox / trash), and dispatches.
- `/import/pending` and `/admin/inbox` UIs exist and are authenticated.
- Staging tables + cleanup cron are in place and running (14-day TTL for staged imports, 24-hour TTL for trash).
- Bounce logic is wired but gated on `RESEND_API_KEY` + SPF/DKIM pass.

---

## 1. Create / log in to Resend

1. Go to <https://resend.com> and sign in with the finlynq account (or create one).
2. Make sure you're on the **Finlynq** workspace in the top-left switcher.

---

## 2. Add `finlynq.com` as a domain

If `finlynq.com` isn't already verified in Resend:

1. In the sidebar, click **Domains → Add Domain**.
2. Enter `finlynq.com` and submit.
3. Resend will show DNS records you need to add (SPF, DKIM, MX). Keep this tab open — we'll come back to it.

---

## 3. Configure DNS records at your DNS provider

Add the following records to `finlynq.com`. If the domain is registered with Cloudflare / Namecheap / Google Domains / etc., find the DNS management page there.

### 3a. MX records (receiving mail)

| Type | Name   | Priority | Value                          | TTL  |
|------|--------|----------|--------------------------------|------|
| MX   | `@`    | 10       | `inbound-smtp.resend.com`      | auto |

> Resend shows the exact inbound MX host in the dashboard — use theirs if it differs. Some providers show `@` as blank or `finlynq.com`.

### 3b. SPF (Resend publishes sender auth)

| Type | Name   | Value                                   | TTL  |
|------|--------|-----------------------------------------|------|
| TXT  | `@`    | `v=spf1 include:_spf.resend.com ~all`   | auto |

If you already have an SPF record for another sender, **merge** — you can only have one SPF record per domain:

```
v=spf1 include:_spf.resend.com include:<other-provider> ~all
```

### 3c. DKIM (Resend signs outbound mail)

Resend will show two or three CNAME records like `resend._domainkey.finlynq.com` → `<random>.resend.com`. Copy each one into DNS as a CNAME.

### 3d. DMARC (optional but strongly recommended)

| Type | Name       | Value                                                 | TTL  |
|------|------------|-------------------------------------------------------|------|
| TXT  | `_dmarc`   | `v=DMARC1; p=none; rua=mailto:admin@finlynq.com`      | auto |

Start with `p=none` so you can watch reports come in without bouncing legitimate mail. Tighten to `p=quarantine` or `p=reject` later.

### 3e. Verify

Back in Resend → **Domains → finlynq.com**, click **Verify DNS Records**. Each record should show ✅. If any fail, wait 10 minutes and try again (DNS propagation). Can take up to 48h in worst cases but usually 5–30 minutes.

---

## 4. Create the Inbound webhook route

This is the step that tells Resend "when mail arrives at finlynq.com, POST it to our webhook."

1. In the Resend sidebar, click **Inbound** (or **Webhooks → Inbound** depending on UI version).
2. Click **Add Inbound Endpoint** (or similar).
3. Fill in:
   - **Match pattern:** `*@finlynq.com` (catch-all — our app handles the 3-way routing itself)
   - **Endpoint URL:** `https://finlynq.com/api/import/email-webhook`
   - **Events:** `email.inbound.received` (or whatever the "new inbound email" event is called in their UI)
4. Save.
5. **Copy the Signing Secret.** It looks like `whsec_<base64gibberish>`. You'll paste this into prod env in step 5.

> If Resend shows a separate test-signing secret vs production one, use production. Both work with our verifier — it just wraps the HMAC-SHA256 compare.

---

## 5. Set the signing secret in prod env

SSH to the prod server as a user with sudo access, then edit `/home/projects/pf/.env`:

```bash
sudo -u paperclip-agent nano /home/projects/pf/.env
```

Find the block that ends with:

```
IMPORT_EMAIL_DOMAIN=finlynq.com
RESEND_WEBHOOK_SECRET=whsec_t1b1...placeholder...
```

Replace the placeholder value with the real secret from step 4:

```
RESEND_WEBHOOK_SECRET=whsec_<the-real-one-from-resend>
```

Save, then restart the service so Next.js picks up the new env:

```bash
sudo systemctl restart pf.service
sudo systemctl is-active pf.service   # → "active"
```

---

## 6. (Optional) Enable bounce emails for trash

When an email arrives at an unknown address (e.g. `asdf@finlynq.com`), the webhook stores it in the trash bin and holds it for 24h. If you want to *also* send a "no such mailbox" reply to the sender, set `RESEND_API_KEY`.

**Important:** we only bounce to senders whose SPF AND DKIM pass — this prevents backscatter (spammers forge `From:` headers; bouncing to forged addresses spams innocent people).

1. In Resend → **API Keys → Create API Key**, name it something like `finlynq-bounce`.
2. Copy the key (starts with `re_`).
3. Append to `/home/projects/pf/.env`:
   ```
   RESEND_API_KEY=re_<your-key>
   BOUNCE_FROM=mailer-daemon@finlynq.com
   ```
4. `sudo systemctl restart pf.service`

If you skip this step, trash emails are still held and admin-notified; they just don't get a bounce reply.

---

## 7. Smoke test

### 7a. Webhook responds correctly on its own

From any machine:

```bash
# Expect 415 (wrong content-type)
curl -i -X POST https://finlynq.com/api/import/email-webhook \
  -H "Content-Type: text/plain" -d hi

# Expect 401 (missing svix signature)
curl -i -X POST https://finlynq.com/api/import/email-webhook \
  -H "Content-Type: application/json" -d '{"from":"x@y.com","to":["admin@finlynq.com"]}'
```

Both should respond as documented. If they don't, the deploy hasn't picked up the new code — check `systemctl status pf`.

### 7b. Real email end-to-end

1. Log in to finlynq.com with your account.
2. Go to **Import → Email Import** and click **Generate Import Email Address**. You'll get `import-<uuid>@finlynq.com`.
3. From your regular email, forward a bank statement (with a CSV attachment) to that address. Or send a test email with any CSV attached.
4. Wait up to 60 seconds.
5. Go to **`/import/pending`** — the import should be listed.
6. Click it, review the parsed rows, hit **Import**. Transactions land in your Transactions page, encrypted under your session DEK.

### 7c. Admin inbox end-to-end

1. Send an email to `asdf@finlynq.com` (unknown address).
2. Go to **`/admin/inbox`** (only visible to users with `role='admin'`).
3. The email should appear in the **Trash** tab with a 24-hour countdown.
4. Send an email to `info@finlynq.com` (reserved prefix).
5. It should appear in the **Mailbox** tab (kept indefinitely).

---

## Troubleshooting

### "Invalid signature" 401 on every webhook

- **Wrong `RESEND_WEBHOOK_SECRET`.** Copy it again from Resend — make sure you copied the whole `whsec_...` string. Restart `pf.service` after editing `.env`.
- **Clock skew.** The webhook rejects timestamps more than ±5 min off UTC. Check `date -u` on the prod server is sane.
- **Body was re-serialized somewhere.** The signature covers the raw bytes; if Caddy / nginx / Cloudflare is rewriting the body (e.g. JSON prettification), HMAC will fail. Our Caddy setup doesn't do this by default; double-check any proxy rules.

### "Webhook not configured" 500

- `RESEND_WEBHOOK_SECRET` is unset in the env the service reads from. `grep RESEND /home/projects/pf/.env` to confirm. Restart `pf.service`.

### MX records don't verify in Resend

- Some providers (Namecheap especially) cache DNS aggressively. Wait 15 min, retry. Use `dig MX finlynq.com @8.8.8.8` from any shell to confirm the record actually resolves to `inbound-smtp.resend.com`.

### Email arrives at Resend but webhook isn't called

- Check the Resend dashboard's **Inbound Logs** — they should show the delivery attempt and the HTTP response we gave.
- If Resend shows retries failing, check `journalctl -u pf.service -n 200` on prod for errors.

### Import address generates the wrong domain

- `IMPORT_EMAIL_DOMAIN` in `.env` defaults to `finlynq.com` but make sure it's set. Regenerating the address from the UI will use the current env value.

### Trash rows don't get bounced even with `RESEND_API_KEY` set

- We only bounce when both SPF and DKIM pass (per the Resend payload's auth verdicts). Check the Resend Inbound log for the actual verdicts — if the sender domain has no SPF or DKIM configured, we intentionally skip the bounce.

---

## Current prod state (as of 2026-04-23)

| Thing | State |
|---|---|
| Code deployed (commits 8dbf0db → a1e1b51) | ✅ live |
| DB migration run | ✅ staged_imports, staged_transactions, incoming_emails all exist with indexes |
| `IMPORT_EMAIL_DOMAIN=finlynq.com` in env | ✅ |
| `RESEND_WEBHOOK_SECRET` in env | ⚠️ placeholder — replace with real Resend secret |
| `RESEND_API_KEY` in env | ❌ unset (bouncer is off) |
| DNS MX records on finlynq.com | ❌ not yet added |
| Resend Inbound route created | ❌ not yet configured |

The placeholder signing secret is real HMAC-valid, so internal smoke tests pass. Once you complete steps 3–5 above, the same code path will authenticate production Resend webhooks.
