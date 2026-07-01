/**
 * SimpleFIN bank-feed orchestrator.
 *
 * SimpleFIN is a live BANK FEED (the user pastes a one-time setup token, the app
 * exchanges it for a long-lived access URL stored encrypted under the DEK, and
 * pulls on demand while logged in). Unlike the file connectors it does NOT write
 * the ledger directly — it stages transactions into the EXISTING
 * `staged_imports` / `/import/pending` review flow, and the user approves them
 * there ("Send to bank ledger" → `bank_transactions`, source='connector', which
 * surfaces on the /import reconciliation page). No `transactions` rows are ever
 * created (a bank feed must not double-count the user's own manual entries).
 *
 * Account mapping is EXPLICIT: `previewSimpleFin` detects the SimpleFIN accounts
 * and classifies each as already-`mapped`, name-`suggested`, or `new`; the UI
 * asks the user to CREATE a new Finlynq account or LINK to an existing one for
 * each new account. `syncSimpleFin(choices)` resolves those choices, persists
 * the SimpleFIN-id → Finlynq-id map (a second encrypted credential slot) so
 * re-syncs never re-prompt, and stages each account's rows into its own
 * account-bound `staged_imports` row via the shared `writeStagedImport`
 * chokepoint (source='connector'). See finlynq-cloud/plan/simplefin-bank-feed.md.
 */

import { db, schema } from "@/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { createAccount } from "@/lib/queries";
import { writeStagedImport, type ParseSuccess } from "@/lib/import/stage-statement-file";
import {
  advanceStagedImportByMode,
  type AccountMode,
  type AdvanceStage,
} from "@/lib/import/advance-by-mode";
import {
  saveConnectorCredentials,
  loadConnectorCredentials,
  hasConnectorCredentials,
  deleteConnectorCredentials,
} from "./credentials";
import { simplefin } from "@finlynq/import-connectors";

const CONNECTOR_ID = "simplefin";
/** Second credential slot: SimpleFIN account id → Finlynq account id (string). */
const ACCOUNT_MAP_ID = "simplefin:accounts";
/** How far back to pull on each sync. SimpleFIN keeps ~90 days. */
const SYNC_LOOKBACK_DAYS = 90;
/** Min gap between login-triggered auto-syncs per user. */
const AUTO_SYNC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Plaintext settings key holding the last auto-sync timestamp (ISO). */
const AUTOSYNC_AT_KEY = "connector:simplefin:autosync_at";

export class SimplefinNotConnectedError extends Error {
  constructor() {
    super("SimpleFIN is not connected");
    this.name = "SimplefinNotConnectedError";
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

/** How a detected SimpleFIN account maps to Finlynq. */
export type SimplefinAccountStatus = "mapped" | "suggested" | "new";

export interface SimplefinAccountPlan {
  /** SimpleFIN account id (stable mapping key). */
  externalId: string;
  /** SimpleFIN account display name. */
  name: string;
  /** ISO currency. */
  currency: string;
  /** Transactions available for this account (last ~90d, pending excluded). */
  txCount: number;
  /**
   * `mapped` — already linked (from a prior sync); syncs silently.
   * `suggested` — a Finlynq account with a matching name exists (pre-fill link).
   * `new` — no match; the user must choose Create or Link.
   */
  status: SimplefinAccountStatus;
  /** Target Finlynq account id (mapped/suggested), else null. */
  accountId: number | null;
  /** Decrypted name of the target account (mapped/suggested), else null. */
  accountName: string | null;
}

export interface SimplefinPreview {
  accounts: SimplefinAccountPlan[];
  /** The user's Finlynq accounts — options for the "link to existing" picker. */
  existingAccounts: Array<{ id: number; name: string; currency: string }>;
  /** Provider + transform errors (non-fatal). */
  errors: string[];
}

/** Per-account decision from the client at sync time. */
export type SimplefinAccountChoice =
  | { mode: "existing"; accountId: number }
  | { mode: "create" };

export interface SimplefinStagedResult {
  stagedImportId: string;
  accountId: number;
  accountName: string;
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  /** The bound account's mode that drove how far this import auto-advanced. */
  mode: AccountMode;
  /** Furthest stage reached: pending (manual) | loaded (approve) | recorded (auto). */
  stage: AdvanceStage;
  /** Rows recorded as transactions (auto only). */
  recorded: number;
}

export interface SimplefinSyncResult {
  /** One staged import per account that had rows. */
  staged: SimplefinStagedResult[];
  accountsCreated: number;
  /** New accounts the caller sent no choice for — nothing staged for these. */
  skippedNoChoice: Array<{ externalId: string; name: string }>;
  /** Pending rows skipped by the transform. */
  skippedPending: number;
  errors: string[];
}

export interface SimplefinConnectResult {
  connected: true;
}

export interface SimplefinStatus {
  connected: boolean;
  /** ISO timestamp of the most recent connector staging run, or null. */
  lastSyncAt: string | null;
}

// ─── Account cache ──────────────────────────────────────────────────────────

interface AccountInfo {
  id: number;
  name: string;
  currency: string;
  mode: AccountMode;
}

// ─── Connect ──────────────────────────────────────────────────────────────

/**
 * Exchange a one-time setup token for an access URL and persist it (encrypted
 * under the DEK). Throws SimpleFinSetupTokenError on a bad/expired token.
 */
export async function connectSimpleFin(
  userId: string,
  dek: Buffer,
  setupToken: string,
): Promise<SimplefinConnectResult> {
  const accessUrl = await simplefin.exchangeSetupToken(setupToken);
  await saveConnectorCredentials(userId, CONNECTOR_ID, dek, { accessUrl });
  return { connected: true };
}

// ─── Fetch + transform (shared by preview + sync) ───────────────────────────

async function fetchAndTransform(userId: string, dek: Buffer) {
  const creds = await loadConnectorCredentials<{ accessUrl: string }>(
    userId,
    CONNECTOR_ID,
    dek,
  );
  if (!creds?.accessUrl) throw new SimplefinNotConnectedError();
  const client = new simplefin.SimpleFINClient(creds.accessUrl);
  const startDate = Math.floor(Date.now() / 1000) - SYNC_LOOKBACK_DAYS * 24 * 60 * 60;
  const resp = await client.fetchAccounts({ startDate });
  return simplefin.simplefinToRawTransactions(resp);
}

// ─── Preview (detect accounts + mapping status) ─────────────────────────────

export async function previewSimpleFin(
  userId: string,
  dek: Buffer,
): Promise<SimplefinPreview> {
  const { accounts, errors } = await fetchAndTransform(userId, dek);
  const { byId, byName } = await loadAccountsFull(userId, dek);
  const map =
    (await loadConnectorCredentials<Record<string, string>>(userId, ACCOUNT_MAP_ID, dek)) ?? {};

  const plans: SimplefinAccountPlan[] = accounts.map((acct) => {
    // Mapped (prior sync) — only if that account still exists.
    const mappedId = map[acct.externalId] ? Number(map[acct.externalId]) : null;
    if (mappedId && byId.has(mappedId)) {
      return {
        externalId: acct.externalId,
        name: acct.name,
        currency: acct.currency,
        txCount: acct.rows.length,
        status: "mapped",
        accountId: mappedId,
        accountName: byId.get(mappedId)!.name,
      };
    }
    // Name-suggested — an existing Finlynq account with a matching name.
    const suggestedId = byName.get(acct.name.toLowerCase().trim()) ?? null;
    if (suggestedId) {
      return {
        externalId: acct.externalId,
        name: acct.name,
        currency: acct.currency,
        txCount: acct.rows.length,
        status: "suggested",
        accountId: suggestedId,
        accountName: byId.get(suggestedId)?.name ?? null,
      };
    }
    return {
      externalId: acct.externalId,
      name: acct.name,
      currency: acct.currency,
      txCount: acct.rows.length,
      status: "new",
      accountId: null,
      accountName: null,
    };
  });

  const existingAccounts = Array.from(byId.values())
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency }))
    .sort((x, y) => x.name.localeCompare(y.name));

  return { accounts: plans, existingAccounts, errors };
}

/** loadAccounts variant returning both maps (byId + byName). */
async function loadAccountsFull(
  userId: string,
  dek: Buffer,
): Promise<{ byId: Map<number, AccountInfo>; byName: Map<string, number> }> {
  const rows = await db
    .select({
      id: schema.accounts.id,
      nameCt: schema.accounts.nameCt,
      currency: schema.accounts.currency,
      mode: schema.accounts.mode,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  const byId = new Map<number, AccountInfo>();
  const byName = new Map<string, number>();
  for (const a of rows) {
    const name = a.nameCt ? tryDecryptField(dek, a.nameCt, "accounts.name_ct") : null;
    if (!name) continue;
    byId.set(a.id, {
      id: a.id,
      name,
      currency: a.currency,
      mode: (a.mode as AccountMode) ?? "manual",
    });
    const key = name.toLowerCase().trim();
    if (key && !byName.has(key)) byName.set(key, a.id);
  }
  return { byId, byName };
}

// ─── Sync (resolve create/link choices → stage per account) ─────────────────

/**
 * Pull the last ~90 days and STAGE each SimpleFIN account's rows into its own
 * account-bound `staged_imports` row (source='connector') for review at
 * /import/pending. `choices` maps a SimpleFIN account id to Create-new or
 * Link-to-existing; already-mapped accounts sync without a choice. A `new`
 * account with no choice is skipped and reported.
 */
export async function syncSimpleFin(
  userId: string,
  dek: Buffer,
  choices: Record<string, SimplefinAccountChoice> = {},
): Promise<SimplefinSyncResult> {
  const { accounts, skippedPending, errors } = await fetchAndTransform(userId, dek);
  const { byId, byName } = await loadAccountsFull(userId, dek);
  const accountMap =
    (await loadConnectorCredentials<Record<string, string>>(userId, ACCOUNT_MAP_ID, dek)) ?? {};
  let mapDirty = false;

  const staged: SimplefinStagedResult[] = [];
  const skippedNoChoice: Array<{ externalId: string; name: string }> = [];
  let accountsCreated = 0;

  for (const acct of accounts) {
   // Per-account isolation: one account's failure (bad data, transient DB
   // error) is collected and skipped so the rest of the sync still runs —
   // important for the background login auto-sync.
   try {
    // ── Resolve the target Finlynq account ──
    let finAccountId: number | undefined;
    let finAccountName: string | undefined;
    // Drives how far the staged import auto-advances (see advanceStagedImportByMode).
    // Newly-created accounts default to 'manual'; a linked/mapped account keeps its mode.
    let finAccountMode: AccountMode = "manual";

    const mappedId = accountMap[acct.externalId] ? Number(accountMap[acct.externalId]) : null;
    if (mappedId && byId.has(mappedId)) {
      const info = byId.get(mappedId)!;
      finAccountId = info.id;
      finAccountName = info.name;
      finAccountMode = info.mode;
    } else {
      const choice = choices[acct.externalId];
      if (choice?.mode === "existing") {
        const info = byId.get(choice.accountId);
        if (info) {
          finAccountId = info.id;
          finAccountName = info.name;
          finAccountMode = info.mode;
        }
      } else if (choice?.mode === "create") {
        // If an account with this exact name already exists (a prior sync, a
        // manual create, or a name collision), LINK to it instead of hitting
        // the unique (user_id, name_lookup) constraint — otherwise create.
        const existingId = byName.get(acct.name.toLowerCase().trim());
        const existing = existingId != null ? byId.get(existingId) : undefined;
        if (existing) {
          finAccountId = existing.id;
          finAccountName = existing.name;
          finAccountMode = existing.mode;
        } else {
          const enc = buildNameFields(dek, { name: acct.name });
          const created = await createAccount(userId, {
            type: "A",
            group: "",
            currency: acct.currency,
            isInvestment: false,
            ...enc,
          } as Parameters<typeof createAccount>[1]);
          finAccountId = created.id;
          finAccountName = acct.name;
          finAccountMode = "manual";
          accountsCreated += 1;
        }
      }
    }

    if (finAccountId === undefined || finAccountName === undefined) {
      // A new account the caller didn't decide on — skip + report.
      skippedNoChoice.push({ externalId: acct.externalId, name: acct.name });
      continue;
    }

    // Persist the mapping so re-syncs never re-prompt.
    if (accountMap[acct.externalId] !== String(finAccountId)) {
      accountMap[acct.externalId] = String(finAccountId);
      mapDirty = true;
    }

    if (acct.rows.length === 0) continue;

    // ── Stage this account's rows (bound account, source='connector') ──
    const rows = acct.rows.map((r) => ({ ...r, account: finAccountName! }));
    // SimpleFIN reports the account's current balance + balance-date. Carry it
    // as the statement balance so approve seeds a `bank_daily_balances` anchor
    // (source 'upload_form') — this drives the reconcile balance check + the
    // "Calculated / Loaded" columns. Balance-vs-90-day-window divergence is
    // warn-but-allow, never blocking.
    const parseResult: ParseSuccess = {
      rows,
      errors: [],
      // format is a placeholder — fileFormatOverride sets the displayed tag.
      format: "csv",
      statementBalance: acct.balance,
      statementBalanceDate: acct.balanceDate,
      statementCurrency: acct.currency,
      anchors: [],
    };
    const result = await writeStagedImport(parseResult, {
      userId,
      dek,
      accountId: finAccountId,
      fileName: `SimpleFIN — ${acct.name}`,
      knobs: {
        skipHeaderRows: 0,
        skipFooterRows: 0,
        dateFormatOverride: null,
        defaultCurrency: acct.currency,
      },
      boundAccountCurrency: acct.currency,
      source: "connector",
      fileFormatOverride: "simplefin",
      // Auto-skip a pulled row when this account already has a transaction /
      // bank row with the same amount within ±3 days (even under a different
      // payee) — re-derived every sync so matches stay skipped without stored
      // state. A false match can still be force-loaded at /import/pending.
      fuzzyDedupWindowDays: 3,
    });

    // Advance by the account's mode — the SAME shared step the manual
    // statement upload uses: manual → stays in /import/pending; approve →
    // auto-loads to bank ledger; auto → loads + fires rules → transactions.
    const advance = await advanceStagedImportByMode({
      userId,
      dek,
      stagedImportId: result.stagedImportId,
      accountId: finAccountId,
      mode: finAccountMode,
    });

    staged.push({
      stagedImportId: result.stagedImportId,
      accountId: finAccountId,
      accountName: finAccountName,
      rowCount: result.rowCount,
      newCount: result.newCount,
      duplicateCount: result.duplicateCount,
      mode: advance.mode,
      stage: advance.stage,
      recorded: advance.recorded,
    });
   } catch (err) {
      errors.push(
        `Account "${acct.name}": ${err instanceof Error ? err.message : "sync failed"}`,
      );
    }
  }

  if (mapDirty) {
    await saveConnectorCredentials(userId, ACCOUNT_MAP_ID, dek, accountMap);
  }

  return { staged, accountsCreated, skippedNoChoice, skippedPending, errors };
}

// ─── Status / disconnect ────────────────────────────────────────────────────

/** Connected? + when the last connector staging run happened. */
export async function getSimpleFinStatus(userId: string): Promise<SimplefinStatus> {
  const connected = await hasConnectorCredentials(userId, CONNECTOR_ID);
  let lastSyncAt: string | null = null;
  if (connected) {
    const row = await db
      .select({ receivedAt: schema.stagedImports.receivedAt })
      .from(schema.stagedImports)
      .where(
        and(
          eq(schema.stagedImports.userId, userId),
          eq(schema.stagedImports.source, "connector"),
        ),
      )
      .orderBy(desc(schema.stagedImports.receivedAt))
      .limit(1)
      .get();
    if (row?.receivedAt) {
      lastSyncAt =
        row.receivedAt instanceof Date ? row.receivedAt.toISOString() : String(row.receivedAt);
    }
  }
  return { connected, lastSyncAt };
}

/** Remove the stored access URL + account map. Does not need the DEK. */
export async function disconnectSimpleFin(userId: string): Promise<void> {
  await deleteConnectorCredentials(userId, CONNECTOR_ID);
  await deleteConnectorCredentials(userId, ACCOUNT_MAP_ID);
}

// ─── Login-triggered auto-sync (~12h throttle) ──────────────────────────────

/** Read the last auto-sync timestamp (ms epoch), or 0 if never. Plaintext. */
async function getAutoSyncAt(userId: string): Promise<number> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.key, AUTOSYNC_AT_KEY), eq(schema.settings.userId, userId)))
    .get();
  if (!row?.value) return 0;
  const t = Date.parse(row.value);
  return Number.isNaN(t) ? 0 : t;
}

/** Upsert the last auto-sync timestamp (plaintext ISO). */
async function setAutoSyncAt(userId: string, iso: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO settings (key, user_id, value)
    VALUES (${AUTOSYNC_AT_KEY}, ${userId}, ${iso})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
  `);
}

/**
 * Sync SimpleFIN in the background iff connected AND the last auto-sync was more
 * than ~12h ago. Only touches ALREADY-MAPPED accounts (empty choices), each
 * advancing per its own mode via the shared pipeline. Returns null when skipped.
 * The timestamp is stamped BEFORE the sync so a slow/failing run doesn't let the
 * next login re-fire immediately.
 */
export async function maybeAutoSyncSimpleFin(
  userId: string,
  dek: Buffer,
): Promise<SimplefinSyncResult | null> {
  if (!(await hasConnectorCredentials(userId, CONNECTOR_ID))) return null;
  const last = await getAutoSyncAt(userId);
  if (Date.now() - last < AUTO_SYNC_MIN_INTERVAL_MS) return null;
  await setAutoSyncAt(userId, new Date().toISOString());
  return syncSimpleFin(userId, dek, {});
}

/**
 * Fire-and-forget wrapper for the login hook. Web + mobile share ONE login
 * endpoint (`POST /api/auth/login`), so wiring this beside the other login-time
 * DEK-bearing jobs covers both clients. Never throws; logs on error.
 */
export function enqueueAutoSyncSimpleFin(userId: string, dek: Buffer): void {
  void (async () => {
    try {
      const res = await maybeAutoSyncSimpleFin(userId, dek);
      if (res && res.staged.length > 0) {
        const recorded = res.staged.reduce((n, s) => n + s.recorded, 0);
        console.log(
          `[simplefin-autosync] user=${userId} accounts=${res.staged.length} recorded=${recorded}`,
        );
      }
    } catch (err) {
      console.warn(`[simplefin-autosync] user=${userId} failed:`, err);
    }
  })();
}
