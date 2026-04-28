// WealthPosition API client. Docs: https://www.wealthposition.com/api/v0.1
// Rate limit: 1 request / second. Bearer auth.

import { createHash } from "crypto";
import { createRateLimitedFetch, type RateLimitedFetch } from "../rate-limited-fetch";
import type {
  ConnectorClient,
  ConnectorListTransactionsOpts,
  ExternalAccount,
  ExternalCategory,
  ExternalTransaction,
} from "../types";

const BASE_URL = "https://www.wealthposition.com/api/v0.1";
const MAX_RATE_LIMIT_RETRIES = 3;

interface WpEnvelope<T> {
  success: boolean;
  error: null | {
    code: string;
    message: string;
    detail: string;
  };
  data: T;
}

interface WpAccount {
  id: string;
  name: string;
  type: "A" | "L";
  currency: string;
  group_name: string;
}

interface WpCategory {
  id: string;
  name: string;
  type: "I" | "E" | "R";
  group_name: string;
}

interface WpTransactionEntry {
  categorization: string;
  currency: string;
  amount: string;
  holding: string | null;
  note?: string;
}

interface WpTransaction {
  id: string;
  date: string;
  reviewed: boolean;
  payee?: string;
  tags?: string[];
  entries: WpTransactionEntry[];
}

interface WpTransactionsPage {
  count: number;
  current_page: number;
  transactions: WpTransaction[];
}

export class WealthPositionApiError extends Error {
  constructor(
    public code: string,
    public detail: string,
    public httpStatus: number,
  ) {
    super(`WealthPosition API error [${code}]: ${detail}`);
    this.name = "WealthPositionApiError";
  }
}

export interface WealthPositionClientOptions {
  apiKey: string;
  /** Override the rate limiter (tests). Defaults to 1 req/sec. */
  fetchImpl?: RateLimitedFetch;
  /** Override the base URL (tests). */
  baseUrl?: string;
}

export class WealthPositionClient implements ConnectorClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: RateLimitedFetch;

  constructor(opts: WealthPositionClientOptions) {
    if (!opts.apiKey) throw new Error("WealthPositionClient: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    // Bucket by SHA of the API key — state survives across client instances
    // spawned by separate HTTP requests in the same process. Multiple users
    // with different keys get independent queues; a single user who clicks
    // Probe then Preview in quick succession can't stampede the 1 req/s limit.
    const bucketKey = `wealthposition:${createHash("sha256").update(opts.apiKey).digest("hex")}`;
    this.fetchImpl =
      opts.fetchImpl ??
      createRateLimitedFetch({ minIntervalMs: 1200, bucketKey });
  }

  private async call<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: WealthPositionApiError | null = null;
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      let body: WpEnvelope<T> | null = null;
      try {
        body = (await res.json()) as WpEnvelope<T>;
      } catch {
        // fall through
      }

      if (res.ok && body?.success) {
        return body.data;
      }

      const code = body?.error?.code ?? `HTTP_${res.status}`;
      const detail = body?.error?.detail ?? body?.error?.message ?? res.statusText;
      lastError = new WealthPositionApiError(code, detail, res.status);

      // Only retry on rate-limit — other errors (401, 400, etc.) fail fast.
      if (code !== "RATE_LIMIT_ERROR" && res.status !== 429) break;
      if (attempt === MAX_RATE_LIMIT_RETRIES) break;
      // Exponential back-off with jitter: 1.5s, 3s, 6s.
      const backoff = 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, backoff));
    }
    throw lastError ?? new WealthPositionApiError("ENDPOINT_ERROR", "Unknown failure", 500);
  }

  async listAccounts(): Promise<ExternalAccount[]> {
    const rows = await this.call<WpAccount[]>("/accounts");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      currency: r.currency,
      groupName: r.group_name || undefined,
    }));
  }

  async listCategories(): Promise<ExternalCategory[]> {
    const rows = await this.call<WpCategory[]>("/categories");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      groupName: r.group_name || undefined,
    }));
  }

  async *listTransactions(
    opts: ConnectorListTransactionsOpts = {},
  ): AsyncIterable<ExternalTransaction[]> {
    const params = new URLSearchParams();
    if (opts.startDate) params.set("start_date", opts.startDate);
    if (opts.endDate) params.set("end_date", opts.endDate);

    let page = 1;
    let fetched = 0;
    while (true) {
      params.set("page", String(page));
      const data = await this.call<WpTransactionsPage>(
        `/transactions?${params.toString()}`,
      );
      const txs = data.transactions ?? [];
      if (txs.length === 0) return;

      yield txs.map(
        (t): ExternalTransaction => ({
          id: t.id,
          date: t.date,
          payee: t.payee,
          tags: t.tags ?? [],
          reviewed: t.reviewed,
          entries: t.entries.map((e) => ({
            categorization: e.categorization,
            amount: e.amount,
            currency: e.currency,
            note: e.note ?? "",
            holding: e.holding,
          })),
        }),
      );

      fetched += txs.length;
      if (fetched >= data.count) return;
      page += 1;
    }
  }

  async getBalances(date: string): Promise<Record<string, number>> {
    const raw = await this.call<
      Record<string, { categorized_balance_account_currency: string }>
    >(`/account_balances?date=${encodeURIComponent(date)}`);
    const out: Record<string, number> = {};
    for (const [id, row] of Object.entries(raw)) {
      const n = parseFloat(row.categorized_balance_account_currency);
      if (!Number.isNaN(n)) out[id] = n;
    }
    return out;
  }
}
