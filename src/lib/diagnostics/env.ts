/**
 * Environment name for diagnostics rows (prod / dev / local).
 *
 * Dev and prod are SEPARATE databases on the same VPS, so each env's
 * diagnostics_log is already isolated — but we stamp the env on each row so a
 * row is self-describing (and a future combined view would be trivial). Derived
 * from APP_URL's hostname; no new env var.
 */

let cached: string | null = null;

export function getEnvName(): string {
  if (cached) return cached;
  const url = process.env.APP_URL ?? "";
  let host = "";
  try {
    host = url ? new URL(url).hostname : "";
  } catch {
    host = "";
  }
  if (host.includes("dev.")) cached = "dev";
  else if (host.includes("localhost") || host.includes("127.0.0.1") || host === "") cached = "local";
  else cached = "prod";
  return cached;
}
