// SimpleFIN API client. Protocol: https://www.simplefin.org/protocol.html
//
// Flow:
//   1. exchangeSetupToken(setupToken) — the setup token is base64 of a one-time
//      CLAIM URL. Decode it, POST (empty body), and the response body IS the
//      ACCESS URL (with HTTP Basic credentials embedded in the userinfo). The
//      claim is one-time: the claim URL is invalid after this call.
//   2. new SimpleFINClient(accessUrl).fetchAccounts() — GET {base}/accounts,
//      splitting the userinfo out of the access URL into an Authorization
//      header (never send credentials in the URL path/query).
//
// This module uses only globals (fetch, Buffer, URL) — no new deps, matching
// the wealthposition client's use of node built-ins.

import type { SimpleFinAccountsResponse } from "./transform";

export class SimpleFinApiError extends Error {
  constructor(
    message: string,
    public httpStatus: number,
  ) {
    super(message);
    this.name = "SimpleFinApiError";
  }
}

/** Thrown when a setup token can't be decoded/exchanged (bad or expired). */
export class SimpleFinSetupTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimpleFinSetupTokenError";
  }
}

/** Injectable for tests. Defaults to the global fetch. */
type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Exchange a one-time SimpleFIN setup token for a long-lived access URL.
 * The setup token is base64 of the claim URL; POSTing to it returns the
 * access URL (which embeds Basic-auth credentials in its userinfo).
 */
export async function exchangeSetupToken(
  setupToken: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchImpl);
  const token = (setupToken || "").trim();
  if (!token) throw new SimpleFinSetupTokenError("Setup token is empty");

  let claimUrl: string;
  try {
    claimUrl = Buffer.from(token, "base64").toString("utf8").trim();
  } catch {
    throw new SimpleFinSetupTokenError("Setup token is not valid base64");
  }
  if (!/^https?:\/\//i.test(claimUrl)) {
    throw new SimpleFinSetupTokenError(
      "Setup token did not decode to a claim URL",
    );
  }

  const res = await withTimeout(
    (signal) =>
      fetchImpl(claimUrl, {
        method: "POST",
        headers: { "Content-Length": "0" },
        signal,
      }),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const body = (await res.text()).trim();
  if (!res.ok) {
    throw new SimpleFinSetupTokenError(
      `Claim failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  if (!/^https?:\/\//i.test(body)) {
    throw new SimpleFinSetupTokenError(
      "Claim did not return a valid access URL",
    );
  }
  return body;
}

export interface FetchAccountsOptions {
  /** Epoch seconds — only return transactions on/after this. */
  startDate?: number;
  /** Epoch seconds — only return transactions on/before this. */
  endDate?: number;
  /** Include still-pending transactions (default false). */
  pending?: boolean;
}

export class SimpleFINClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(
    accessUrl: string,
    opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
  ) {
    let parsed: URL;
    try {
      parsed = new URL(accessUrl);
    } catch {
      throw new SimpleFinApiError("Invalid SimpleFIN access URL", 0);
    }
    const user = decodeURIComponent(parsed.username);
    const pass = decodeURIComponent(parsed.password);
    this.authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    // Strip credentials from the URL we actually hit — creds go in the header.
    parsed.username = "";
    parsed.password = "";
    // Drop any trailing slash so `${base}/accounts` is well-formed.
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchImpl);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetchAccounts(
    opts: FetchAccountsOptions = {},
  ): Promise<SimpleFinAccountsResponse> {
    const params = new URLSearchParams();
    if (opts.startDate != null) params.set("start-date", String(Math.floor(opts.startDate)));
    if (opts.endDate != null) params.set("end-date", String(Math.floor(opts.endDate)));
    if (opts.pending) params.set("pending", "1");
    const qs = params.toString();
    const url = `${this.baseUrl}/accounts${qs ? `?${qs}` : ""}`;

    const res = await withTimeout(
      (signal) =>
        this.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: this.authHeader, Accept: "application/json" },
          signal,
        }),
      this.timeoutMs,
    );

    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new SimpleFinApiError(
        `SimpleFIN /accounts failed (HTTP ${res.status})${text ? `: ${text}` : ""}`,
        res.status,
      );
    }

    let body: SimpleFinAccountsResponse;
    try {
      body = (await res.json()) as SimpleFinAccountsResponse;
    } catch {
      throw new SimpleFinApiError("SimpleFIN /accounts returned non-JSON", res.status);
    }
    if (!body || !Array.isArray(body.accounts)) {
      throw new SimpleFinApiError("SimpleFIN /accounts response missing accounts[]", res.status);
    }
    return body;
  }
}

/** Run a fetch with an AbortSignal timeout. */
async function withTimeout(
  run: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
