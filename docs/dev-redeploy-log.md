# Dev redeploy log

Append-only log of **manual** `dev` redeploys triggered to rotate `DEPLOY_GENERATION`
(which invalidates in-flight JWTs) — typically to exercise post-deploy auth flows on the
mobile app (biometric silent re-login, 401 auto-redirect) against `dev.finlynq.com`.

A markdown-only change here is build-safe and lives outside `mobile/**`, so it triggers
`deploy-dev.yml` (which ignores mobile-only pushes). Reuse this file for future manual
redeploys instead of pushing throwaway commits.

| When (UTC) | Why |
|---|---|
| 2026-06-12T09:47:46Z | Rotate `DEPLOY_GENERATION` so FINLYNQ-134 (biometric re-login) + FINLYNQ-135 (session-expiry redirect) can be tested on the mobile 1.0.9 build. |
| 2026-06-12T15:27:21Z | Restart dev to wipe the in-memory DEK session so the mobile app (pointed at dev) can reproduce the `session_locked` / lost-DEK state for FINLYNQ-152. |
| 2026-06-12T16:20:50Z | Restart dev again to wipe the DEK session for another mobile session_locked / biometric-recovery test pass. |
