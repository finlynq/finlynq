import { NextRequest, NextResponse } from "next/server";

/**
 * CSP violation report sink (FINLYNQ-83 phase 1).
 *
 * Receives reports from both:
 *   - CSP Level 2: `application/csp-report` → `{ "csp-report": { ... } }`
 *   - Reporting API (CSP Level 3): `application/reports+json` → `[{ type, body, ... }]`
 *
 * Logs structured JSON to stdout so the deploy host's systemd journal
 * (journalctl -u finlynq.service) is the inventory channel for the
 * `style-src 'unsafe-inline'` removal migration.
 *
 * Intentionally UNAUTHENTICATED — anonymous landing-page visitors must be
 * able to POST violations (that's where Recharts + framer-motion render the
 * highest-volume styles). Rate-limit at the proxy layer (Caddy) if abuse
 * becomes a problem.
 *
 * Spec compliance:
 *   - 204 No Content is the recommended response per the CSP spec.
 *   - Malformed JSON → 204 + clamped console.warn (browsers retry on 5xx,
 *     which would flood the journal; 204 is the contract).
 *   - No request-body size limit enforced here — Next.js' built-in body
 *     parser caps at 1MB which is well above CSP report size.
 */
export const dynamic = "force-dynamic";

interface ParsedReport {
  blockedURI: string | null;
  violatedDirective: string | null;
  documentURI: string | null;
  sourceFile: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  sampleHash: string | null;
}

function extractReport(inner: Record<string, unknown>): ParsedReport {
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (inner[k] !== undefined && inner[k] !== null) return inner[k];
    }
    return null;
  };
  const sample = pick("sample");
  return {
    blockedURI: (pick("blockedURI", "blocked-uri") as string) ?? null,
    violatedDirective:
      (pick("violatedDirective", "violated-directive", "effectiveDirective", "effective-directive") as string) ?? null,
    documentURI: (pick("documentURI", "document-uri") as string) ?? null,
    sourceFile: (pick("sourceFile", "source-file") as string) ?? null,
    lineNumber:
      typeof pick("lineNumber", "line-number") === "number"
        ? (pick("lineNumber", "line-number") as number)
        : null,
    columnNumber:
      typeof pick("columnNumber", "column-number") === "number"
        ? (pick("columnNumber", "column-number") as number)
        : null,
    // Clamp the sample to 200 chars — it's the load-bearing hash input for
    // phases 3/4 but we don't want unbounded log lines from misbehaving
    // browsers / probes.
    sampleHash: typeof sample === "string" ? sample.slice(0, 200) : null,
  };
}

export async function POST(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // Malformed body — read raw text (clamped) and move on. Browsers will
    // not retry a 204, so the journal stays clean.
    const text = await req.text().catch(() => "");
    console.warn("[csp-report] malformed body:", text.slice(0, 500));
    return new NextResponse(null, { status: 204 });
  }

  // CSP Level 2 shape: `{ "csp-report": { ... } }` — single report object.
  // Reporting API shape: `[{ type, body: { ... } }, ...]` — array of reports.
  const reports = Array.isArray(body) ? body : [body];
  for (const raw of reports) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    // Reporting API wraps the violation in `r.body`; CSP Level 2 nests it
    // under `r["csp-report"]`. Older browsers / probes may post the inner
    // shape directly.
    const inner =
      (r.body as Record<string, unknown>) ??
      (r["csp-report"] as Record<string, unknown>) ??
      r;
    const parsed = extractReport(inner);
    console.log("[csp-report]", JSON.stringify(parsed));
  }

  return new NextResponse(null, { status: 204 });
}

// GET is intentionally not handled — CSP reports are POST-only. Next.js will
// return 405 by default.
