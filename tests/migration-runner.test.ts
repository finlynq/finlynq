/**
 * Guards the two migration runners against drift (GH #312 / FINLYNQ-293).
 *
 * `deploy.sh` (bash + psql, used by prod/dev) and `scripts/run-migrations.mjs`
 * (node + pg, used by the Docker image) implement the SAME contract against the
 * same `schema_migrations` ledger. Two implementations of one rule is a standing
 * drift risk, so the contract is asserted here rather than trusted to review.
 *
 * These are static-source assertions on purpose — no database required, so they
 * run in the ordinary unit-test job.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const DEPLOY_SH = readFileSync(path.join(ROOT, "deploy.sh"), "utf8");
const RUNNER = readFileSync(path.join(ROOT, "scripts", "run-migrations.mjs"), "utf8");
const MIGRATIONS_DIR = path.join(ROOT, "scripts", "migrations");
const BASELINE = path.join(ROOT, "scripts", "baseline", "0001_schema_baseline.sql");

describe("migration runner parity", () => {
  it("both runners derive the version from the basename minus .sql", () => {
    expect(DEPLOY_SH).toContain('basename "$file" .sql');
    expect(RUNNER).toContain('path.basename(f, ".sql")');
  });

  it("both runners enforce the same filename gate", () => {
    // The gate is the sole barrier against SQL injection via a hostile migration
    // filename, because both runners interpolate/parameterise the version.
    expect(DEPLOY_SH).toContain("^[A-Za-z0-9_-]+$");
    expect(RUNNER).toContain("/^[A-Za-z0-9_-]+$/");
  });

  it("both runners apply the baseline only when the database is empty", () => {
    const guard = "c.relname <> 'schema_migrations'";
    expect(DEPLOY_SH).toContain(guard);
    expect(RUNNER).toContain(guard);
    expect(DEPLOY_SH).toContain("0001_schema_baseline.sql");
    expect(RUNNER).toContain("0001_schema_baseline.sql");
  });

  it("every migration filename passes the gate both runners enforce", () => {
    const bad = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => path.basename(f, ".sql"))
      .filter((v) => !/^[A-Za-z0-9_-]+$/.test(v));
    expect(bad).toEqual([]);
  });

  it("no migration opens its own transaction", () => {
    // Both runners wrap file body + ledger INSERT in ONE transaction. An inner
    // COMMIT would close it early and decouple the bookkeeping from the DDL,
    // so a later failure would leave the migration recorded but half-applied.
    const offenders: string[] = [];
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")
        .replace(/--[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      if (/^\s*(BEGIN|COMMIT|END)\s*;/im.test(sql)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe("schema baseline", () => {
  it("exists — without it no from-zero install is possible", () => {
    // Replaying scripts/migrations/ against an empty database was measured on
    // 2026-07-24: 38 of 70 files fail, 43 of 70 tables created. The baseline is
    // the only complete from-zero path.
    expect(existsSync(BASELINE)).toBe(true);
  });

  it("records exactly the migrations that exist at or before it", () => {
    const sql = readFileSync(BASELINE, "utf8");
    const recorded = new Set([...sql.matchAll(/^\s*\('([^']+)'\)/gm)].map((m) => m[1]));
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => path.basename(f, ".sql"));

    // A migration added AFTER the baseline is correctly absent from the list —
    // it must run on a fresh database. But a recorded version that no longer
    // exists on disk means the list has gone stale.
    const orphaned = [...recorded].filter((v) => !onDisk.includes(v));
    expect(orphaned).toEqual([]);
  });

  it("does not open its own transaction", () => {
    const sql = readFileSync(BASELINE, "utf8").replace(/--[^\n]*/g, "");
    expect(/^\s*(BEGIN|COMMIT)\s*;/im.test(sql)).toBe(false);
  });

  it("creates the ledger it writes to", () => {
    const sql = readFileSync(BASELINE, "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS schema_migrations/i);
    expect(sql).toMatch(/INSERT INTO schema_migrations/i);
    expect(sql).toMatch(/ON CONFLICT \(version\) DO NOTHING/i);
  });
});

describe("docker image can actually run the migrations", () => {
  it("the entrypoint does not require drizzle-orm", () => {
    // Next's standalone output compiles drizzle-orm into the server bundle
    // rather than emitting it as a resolvable package, so an external require
    // can never succeed in the published image (GH #312, bug 2).
    // Comments are stripped first — the entrypoint documents the old broken
    // call on purpose, and that prose must not trip this guard.
    const entrypoint = readFileSync(path.join(ROOT, "scripts", "entrypoint.sh"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(entrypoint).not.toMatch(/require\(['"]drizzle-orm/);
    expect(RUNNER).not.toMatch(/from ['"]drizzle-orm/);
  });

  it("the runner only imports packages the image actually ships", () => {
    // `pg` is in next.config.ts `serverExternalPackages`, so it IS emitted into
    // the standalone output. Anything else must be a node: builtin.
    const imports = [...RUNNER.matchAll(/^import .*? from ["']([^"']+)["']/gm)].map((m) => m[1]);
    const external = imports.filter((i) => !i.startsWith("node:"));
    expect(external).toEqual(["pg"]);

    const nextConfig = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(nextConfig).toMatch(/serverExternalPackages:\s*\[[^\]]*"pg"/);
  });

  it("the Dockerfile ships the baseline, the chain, and the runner", () => {
    const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("scripts/baseline");
    expect(dockerfile).toContain("scripts/migrations");
    expect(dockerfile).toContain("scripts/run-migrations.mjs");
  });

  it("the entrypoint parses both postgres:// and postgresql:// URLs", () => {
    const entrypoint = readFileSync(path.join(ROOT, "scripts", "entrypoint.sh"), "utf8");
    // docker-compose.yml ships the postgresql:// spelling; an entrypoint regex
    // anchored on postgres:// alone crash-looped every published tag (bug 1).
    expect(entrypoint).toContain("postgres(ql)?://");
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    const scheme = compose.match(/DATABASE_URL:\s*(postgres(?:ql)?):\/\//)?.[1];
    expect(scheme).toBeDefined();
    expect(["postgres", "postgresql"]).toContain(scheme);
  });

  it("the entrypoint stamps DEPLOY_GENERATION", () => {
    // currentDeployGeneration() throws in production when this is unset, so
    // without a stamp every self-hosted container 500s on login and register.
    // deploy.sh does this via a systemd drop-in; the container equivalent of a
    // deploy is a container start. A fixed value in compose would defeat the
    // forced-re-auth property, so it must be stamped here, not configured.
    const entrypoint = readFileSync(path.join(ROOT, "scripts", "entrypoint.sh"), "utf8");
    expect(entrypoint).toMatch(/DEPLOY_GENERATION=\$\(date \+%s\)/);
    expect(entrypoint).toContain("export DEPLOY_GENERATION");

    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    const active = compose
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(active).not.toMatch(/DEPLOY_GENERATION\s*:/);
  });

  it("the entrypoint's sed backreferences point at the right capture group", () => {
    // Making the scheme optional adds `(ql)?` as capture group 1, so the value
    // we want becomes group 2 in BOTH expressions. An off-by-one here is quiet
    // and nasty: sed errors to stderr, the assignment comes back empty, and the
    // port silently falls back to 5432 — fine against the default, broken
    // against any custom port. Caught in review of this very fix.
    const entrypoint = readFileSync(path.join(ROOT, "scripts", "entrypoint.sh"), "utf8");
    const seds = [...entrypoint.matchAll(/sed -E 's\|([^']+)\|'/g)].map((m) => m[1]);
    expect(seds.length).toBeGreaterThanOrEqual(2);

    for (const expr of seds) {
      const [pattern, replacement] = expr.split("|");
      // Count capture groups: '(' not preceded by a backslash and not '(?'.
      const groups = (pattern.match(/(?<!\\)\((?!\?)/g) ?? []).length;
      for (const ref of replacement.match(/\\(\d)/g) ?? []) {
        const n = Number(ref.slice(1));
        expect(
          n,
          `backreference ${ref} in "${expr}" exceeds its ${groups} capture group(s)`,
        ).toBeLessThanOrEqual(groups);
      }
    }
  });
});
