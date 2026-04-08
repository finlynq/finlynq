# Deployment Guide

Production URL: **https://finlynq.com**
VPS IP: `77.42.84.176`

---

## How the CI/CD Pipeline Works

Every push to `main` triggers `.github/workflows/deploy.yml`:

```
push to main
    │
    ├─ lint        ─┐
    ├─ typecheck    ├── run in parallel
    └─ test        ─┘
           │
           ▼ (all pass)
        deploy
           │
           ├─ SSH → sudo /home/projects/pf/deploy.sh
           └─ Verify: systemctl status pf + HTTP health check
```

### What `deploy.sh` Does (server-side)

1. `git pull --ff-only` — fast-forward to latest main
2. `npm ci --prefer-offline` — install exact deps from lock file
3. `npm run build` — Next.js standalone build (`output: "standalone"`)
4. Copy `.next/static` and `public/` into `.next/standalone/` (required for standalone mode)
5. `sudo systemctl restart pf` — restart the systemd service
6. Verify the service came up healthy

The app starts as `ExecStart=/usr/bin/node .next/standalone/server.js` on port `3456`, reverse-proxied by Caddy to HTTPS.

---

## GitHub Secrets to Configure

Go to **GitHub → Settings → Secrets and variables → Actions** and add:

| Secret | Value | Notes |
|--------|-------|-------|
| `DEPLOY_SSH_HOST` | `77.42.84.176` | VPS IP (or `finlynq.com`) |
| `DEPLOY_SSH_USER` | `deploy` | Deploy user with passwordless sudo |
| `DEPLOY_SSH_PRIVATE_KEY` | (private key contents) | See SSH key setup below |
| `DEPLOY_SSH_PORT` | `22` | Standard SSH port |

### SSH Key Setup (one-time)

Generate a dedicated deploy key (do **not** reuse your personal key):

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/pf_deploy -N ""
```

Add the **public key** to the server:

```bash
ssh deploy@77.42.84.176 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys" < ~/.ssh/pf_deploy.pub
```

Copy the **private key** into the GitHub Secret `DEPLOY_SSH_PRIVATE_KEY`:

```bash
cat ~/.ssh/pf_deploy
```

Paste the entire output (including `-----BEGIN...` and `-----END...` lines) as the secret value.

---

## Server Structure

```
VPS: 77.42.84.176
├── Caddy (reverse proxy)
│   └── finlynq.com → localhost:3456
│
├── systemd: pf.service
│   ├── User: paperclip-agent
│   ├── WorkingDirectory: /home/projects/pf
│   ├── ExecStart: /usr/bin/node .next/standalone/server.js
│   └── PORT=3456, NODE_ENV=production
│
├── App: /home/projects/pf/
│   ├── .next/standalone/server.js  ← production entrypoint
│   ├── deploy.sh                   ← called by CI/CD
│   └── .env                        ← runtime secrets (not in git)
│
└── Database: PostgreSQL on 127.0.0.1:5432 (db: pf)
```

---

## Manually Triggering a Deploy

### Via GitHub UI

1. Go to **Actions → Deploy to Production**
2. Click **Run workflow**
3. Optionally check **Skip build** to restart with the current `.next` build (faster, useful after config-only changes)
4. Click **Run workflow**

### Via GitHub CLI

```bash
# Full deploy (pull + build + restart)
gh workflow run deploy.yml --ref main

# Skip build (restart only)
gh workflow run deploy.yml --ref main -f skip_build=true
```

### Directly on the Server

SSH in and run the deploy script manually:

```bash
ssh deploy@77.42.84.176
sudo /home/projects/pf/deploy.sh

# Options:
sudo /home/projects/pf/deploy.sh --skip-pull   # build + restart without git pull
sudo /home/projects/pf/deploy.sh --skip-build  # pull + restart without rebuild
```

---

## Checking Service Health

```bash
# Service status
ssh deploy@77.42.84.176 "sudo systemctl status pf"

# Logs (last 50 lines)
ssh deploy@77.42.84.176 "sudo journalctl -u pf -n 50 --no-pager"

# Live log stream
ssh deploy@77.42.84.176 "sudo journalctl -u pf -f"
```

---

## Environment Variables

Runtime environment is configured in `/home/projects/pf/.env` on the server (not committed to git). Key variables:

| Variable | Description |
|----------|-------------|
| `PORT` | App port (`3456`) — set in systemd unit |
| `NODE_ENV` | `production` — set in systemd unit |
| `DATABASE_URL` | PostgreSQL connection string |
| `PF_JWT_SECRET` | JWT signing secret |
| `APP_URL` | `https://finlynq.com` |

To update a production env var, edit `.env` on the server and restart:

```bash
ssh deploy@77.42.84.176
sudo nano /home/projects/pf/.env
sudo systemctl restart pf
```
