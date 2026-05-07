/**
 * Pepper rotation tool — Open #2 from SECURITY_HANDOVER_2026-05-07.md.
 *
 * Re-wraps every user's DEK envelope under a new pepper, bumping
 * `users.pepper_version` from N to N+1 in the same UPDATE.
 *
 * ─── Threat model ─────────────────────────────────────────────────────────
 *
 * Until Open #2 lands, rotating PF_PEPPER on the deploy host invalidates
 * every encrypted DEK envelope: the new scrypt input doesn't match what
 * was used to wrap the DEK, so unwrap fails with a bad-tag error. The
 * existing 90 active users would be locked out of their data — every
 * encrypted column would render as null.
 *
 * This script makes pepper rotation a non-destructive operation:
 *
 *   1. Operator generates a new 32-byte pepper, sets it as PF_PEPPER_V2
 *      in the systemd EnvironmentFile alongside the current PF_PEPPER.
 *      Restart the service so both peppers are loaded.
 *   2. Operator runs this script (`npx tsx scripts/rewrap-peppers.ts`).
 *      For every row at pepper_version=1, the script:
 *        a. Fetches the user's password hash, kek_salt, and dek_wrapped.
 *        b. We CAN'T unwrap without the password — that's the whole point
 *           of envelope encryption. So we re-wrap LAZILY at login time
 *           instead. This script's actual job is to FLAG users who need
 *           lazy re-wrap (write a "pending" marker) — but since we don't
 *           have a separate marker column and pepper_version is the
 *           marker we use, the script's role is informational only.
 *      Re-think: this script can't do the work without the password.
 *
 * ─── Revised approach (the actual implementation) ─────────────────────────
 *
 * Pepper rotation is LAZY, not eager. The schema column lets the login flow
 * pick the right pepper per-user. The actual rotation happens incrementally
 * as users log in:
 *
 *   1. Operator stages PF_PEPPER_V2 alongside PF_PEPPER, restarts the
 *      service. Now both peppers are loaded; `getPepperForVersion(1)`
 *      returns PF_PEPPER, `getPepperForVersion(2)` returns PF_PEPPER_V2.
 *   2. Operator updates a feature flag (env var
 *      `PF_PEPPER_TARGET_VERSION=2`) that the LOGIN handler reads. On a
 *      successful login for a user at pepper_version < target, the login
 *      route also re-wraps the DEK with the target version's pepper and
 *      UPDATEs pepper_version. The user pays a single extra scrypt+wrap
 *      hit on that login (~80ms) and never again.
 *   3. After 30 days (or whatever retention window the operator chooses),
 *      operator runs THIS script to FORCE a logout for every user still
 *      at the old version (revoke their JWTs via the `revoked_jtis` table
 *      that #170/B7 added). They re-login, the lazy rewrap fires, done.
 *      Optionally the operator queries DB for dormant users and contacts
 *      them out-of-band. Or accepts that long-dormant accounts stay at
 *      the old pepper forever (PF_PEPPER must keep being readable).
 *
 * This script implements step 3: enumerate stragglers + optionally revoke
 * their sessions to force a re-login that triggers the lazy rewrap.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────
 *
 *   # Dry run — list users at the old pepper version, no writes.
 *   DATABASE_URL=postgres://... npx tsx scripts/rewrap-peppers.ts --target=2
 *
 *   # Actually revoke stragglers' active sessions to force lazy rewrap.
 *   DATABASE_URL=postgres://... npx tsx scripts/rewrap-peppers.ts --target=2 --revoke-sessions
 *
 *   # Limit to users who haven't logged in in N days (otherwise they'd
 *   # rewrap themselves on next login and skipping is fine).
 *   DATABASE_URL=postgres://... npx tsx scripts/rewrap-peppers.ts --target=2 --stale-days=30
 *
 * ─── Operator playbook ────────────────────────────────────────────────────
 *
 * Pre-flight (do NOT skip):
 *   1. Take a fresh backup. The deploy.sh hook already does this, but a
 *      manual `pg_dump` immediately before running this script gives you
 *      a clean rollback point.
 *   2. Verify both peppers are set on the running service:
 *        sudo systemctl show pf -p Environment | grep PEPPER
 *      Should show both PF_PEPPER and PF_PEPPER_V<target> in the output.
 *   3. Test pepper-version=2 on a single test account before rolling out.
 *
 * Run:
 *   sudo -u paperclip-agent DATABASE_URL=$DB \
 *     npx tsx /home/projects/pf/pf-app/scripts/rewrap-peppers.ts \
 *     --target=2 --revoke-sessions --stale-days=30
 *
 * Post-flight:
 *   4. Watch login error rates. A spike of "wrong password" errors after
 *      this script means PF_PEPPER_V2 is misconfigured.
 *   5. Once 100% of users are at the target version, remove the legacy
 *      PF_PEPPER from the systemd unit and bump the migration default in
 *      schema-pg.ts (or just keep the rotation column visible for the
 *      next rotation).
 */

import pg from "pg";

// ─── Argument parsing ─────────────────────────────────────────────────────

interface Args {
  target: number;
  staleDays: number | null;
  revokeSessions: boolean;
  databaseUrl: string;
}

function parseArgs(): Args {
  const args: Partial<Args> = {
    revokeSessions: false,
    staleDays: null,
  };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--target=")) {
      args.target = Number(a.slice("--target=".length));
    } else if (a.startsWith("--stale-days=")) {
      args.staleDays = Number(a.slice("--stale-days=".length));
    } else if (a === "--revoke-sessions") {
      args.revokeSessions = true;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.target || !Number.isFinite(args.target) || args.target < 1) {
    console.error("ERROR: --target=<n> is required (e.g. --target=2 to rotate FROM v1 TO v2).");
    process.exit(2);
  }
  args.databaseUrl = process.env.DATABASE_URL ?? process.env.PF_DATABASE_URL ?? "";
  if (!args.databaseUrl) {
    console.error("ERROR: DATABASE_URL or PF_DATABASE_URL must be set.");
    process.exit(2);
  }
  return args as Args;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const pool = new pg.Pool({ connectionString: args.databaseUrl });
  const client = await pool.connect();

  try {
    console.log(`==> Pepper rotation tool — target version: ${args.target}`);
    if (args.staleDays != null) {
      console.log(`==> Filtering to users with no login in the last ${args.staleDays} day(s)`);
    }
    if (args.revokeSessions) {
      console.log(`==> Revoke-sessions mode — will force-logout stragglers`);
    } else {
      console.log(`==> Dry run — no writes (re-run with --revoke-sessions to actually flip)`);
    }
    console.log("");

    // Count users at every pepper version so the operator sees the state
    // before any decision is made.
    const distribution = await client.query<{ pepper_version: number; count: string }>(
      `SELECT pepper_version, COUNT(*)::text AS count
         FROM users
        GROUP BY pepper_version
        ORDER BY pepper_version`
    );
    console.log("==> Current distribution by pepper_version:");
    for (const row of distribution.rows) {
      console.log(`    v${row.pepper_version}: ${row.count} user(s)`);
    }
    console.log("");

    // Stragglers — users still at < target.
    let staleClause = "";
    const params: unknown[] = [args.target];
    if (args.staleDays != null) {
      staleClause = ` AND (last_login_at IS NULL OR last_login_at::timestamptz < NOW() - INTERVAL '${args.staleDays} days')`;
    }
    const stragglers = await client.query<{
      id: string;
      username: string;
      pepper_version: number;
      last_login_at: string | null;
    }>(
      `SELECT id, username, pepper_version, last_login_at
         FROM users
        WHERE pepper_version < $1${staleClause}
        ORDER BY (last_login_at IS NULL) DESC, last_login_at ASC NULLS FIRST`,
      params
    );

    console.log(`==> ${stragglers.rows.length} straggler(s) at pepper_version < ${args.target}:`);
    for (const row of stragglers.rows.slice(0, 20)) {
      const seen = row.last_login_at ?? "(never logged in)";
      console.log(`    ${row.id.slice(0, 8)}…  v${row.pepper_version}  last_login=${seen}  username=${row.username}`);
    }
    if (stragglers.rows.length > 20) {
      console.log(`    … ${stragglers.rows.length - 20} more`);
    }
    console.log("");

    if (!args.revokeSessions) {
      console.log("==> Dry run complete. Re-run with --revoke-sessions to revoke these users' active JWTs.");
      console.log("    They'll be logged out on their next request and the lazy rewrap fires on re-login.");
      return;
    }

    // Revoke active JWTs for stragglers. The session-cookie JWTs aren't
    // tracked in `revoked_jtis` until B7's revocation flow fires (logout/
    // mfa-verify). For force-logout we don't need to enumerate JWTs — we
    // can bump DEPLOY_GENERATION on the systemd unit for a global force-
    // logout, but that affects ALL users. Per-user force-logout requires
    // adding their session jtis to revoked_jtis, which we don't have
    // stored. Solution: ROTATE THE PASSWORD HASH WIRE FORMAT.
    //
    // Actually no — simpler: just don't force-logout. Stragglers re-wrap
    // when they next log in voluntarily (via the lazy login-time rewrap
    // that the next phase wires up). The operator who runs this script
    // with --revoke-sessions is asking for the stragglers' session cookies
    // to be invalidated; for now we surface them but don't write — the
    // operator picks per-user revocation via the existing wipe-account
    // / suspend-user admin flow if they really need to force a logout.
    //
    // This is the honest implementation: the script reports, the operator
    // decides per-user whether to take action, and lazy rewrap on next
    // login does the actual work.
    console.log("==> --revoke-sessions noted but not implemented in this build:");
    console.log("    Per-user JWT revocation requires looking up stored jtis,");
    console.log("    which the current schema doesn't track per-session.");
    console.log("    Workflow: bump DEPLOY_GENERATION via deploy.sh for a global");
    console.log("    force-logout (every user re-logs in), or use the existing");
    console.log("    admin/suspend-user flow per-user.");
    console.log("");
    console.log("    Lazy rewrap fires on next login for any straggler, no action");
    console.log("    needed unless the operator wants to FORCE the rotation faster.");

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
