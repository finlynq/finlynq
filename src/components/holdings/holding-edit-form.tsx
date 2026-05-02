"use client";

/**
 * <HoldingEditForm> — shared portfolio_holding create/edit form.
 *
 * Issue #100: extracted from the inline `HoldingEditDialog` previously
 * defined in src/app/(app)/portfolio/page.tsx so that BOTH /portfolio
 * and /settings/investments mount the SAME component. Driving both
 * surfaces from a single source prevents the kind of silent drift that
 * happens when one page gains a new field and the other doesn't.
 *
 * Key behaviors preserved from the original dialog:
 *   - Symbol-aware auto-detection via /api/portfolio/symbol-info (400ms
 *     debounce). Fills currency + isCrypto unless the user has touched
 *     the currency field manually (`currencyTouched` is sticky).
 *   - Canonical-row UX (issue #25): when the row is tickered / cash-as-
 *     currency / "Cash" sleeve, the Name field is disabled with a hint
 *     and the PUT payload omits `name` so the API doesn't 400.
 *   - The shared isCanonicalHolding() predicate from
 *     src/lib/schemas/holding.ts mirrors the API's check exactly. The
 *     same module owns the Zod schemas, so client validation never
 *     diverges from the server's Zod parse.
 *
 * Mode is controlled by `holdingId`:
 *   - undefined → create. POST /api/portfolio.
 *   - number    → edit. Fetches the existing row (or accepts a
 *                 pre-populated `initialHolding` to skip the fetch on
 *                 surfaces that already have it loaded). PUT /api/portfolio.
 *
 * The form OWNS its fetch calls; surfaces only react to onSave(result),
 * onDelete(), onCancel() callbacks. Surfaces never construct the body
 * themselves — eliminating per-surface payload divergence.
 *
 * Stream D / encryption: writes go through /api/portfolio so the dual-
 * write of name + name_ct + name_lookup (and symbol + symbol_ct +
 * symbol_lookup) happens server-side via buildNameFields(). Do NOT
 * introduce direct DB writes from this component — bypassing the route
 * would break the encrypted column path and the row would be invisible
 * to every Phase-3 plaintext-NULL'd read path.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, AlertTriangle } from "lucide-react";
import { SUPPORTED_FIAT_CURRENCIES } from "@/lib/fx/supported-currencies";
import {
  holdingCreateSchema,
  holdingUpdateSchema,
  isCanonicalHolding,
} from "@/lib/schemas/holding";

export type HoldingEditFormHolding = {
  id: number;
  accountId: number | null;
  name: string | null;
  symbol: string | null;
  currency: string | null;
  isCrypto?: number | boolean | null;
  note?: string | null;
};

export type HoldingEditFormResult =
  | { kind: "saved"; holding: Record<string, unknown> }
  | { kind: "deleted"; unlinkedTransactions: number };

type Account = { id: number; name: string; currency: string };

type SymbolInfo = {
  kind: string;
  currency: string | null;
  label: string;
  source: string;
  isCrypto?: boolean;
};

export type HoldingEditFormProps = {
  /** Edit mode if provided; undefined ⇒ create mode. */
  holdingId?: number;
  /** Pre-populate edit-mode form without an extra GET round-trip. */
  initialHolding?: HoldingEditFormHolding;
  /** Pre-select Account dropdown in create mode. */
  defaultAccountId?: number;
  /** Called after a successful POST/PUT/DELETE. */
  onSave: (result: HoldingEditFormResult) => void;
  /** Called when the user closes / cancels. */
  onCancel: () => void;
};

export function HoldingEditForm({
  holdingId,
  initialHolding,
  defaultAccountId,
  onSave,
  onCancel,
}: HoldingEditFormProps) {
  const isCreateMode = holdingId === undefined;

  // Holding currency = the holding's price/quote currency (USD for AAPL,
  // CAD for VCN.TO, BTC for Bitcoin, USD for a USD cash position). Default
  // falls back to the linked account's currency for unknown / crypto.
  const [form, setForm] = useState({
    name: initialHolding?.name ?? "",
    symbol: initialHolding?.symbol ?? "",
    currency: initialHolding?.currency ?? "CAD",
    isCrypto:
      typeof initialHolding?.isCrypto === "number"
        ? initialHolding.isCrypto === 1
        : Boolean(initialHolding?.isCrypto),
    note: initialHolding?.note ?? "",
    accountId:
      initialHolding?.accountId != null
        ? String(initialHolding.accountId)
        : defaultAccountId != null
          ? String(defaultAccountId)
          : "",
  });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [hydrated, setHydrated] = useState(initialHolding !== undefined || isCreateMode);

  // Symbol auto-detection state. Lookup runs on Symbol blur or after a
  // 400ms debounce of typing, hits /api/portfolio/symbol-info, and populates
  // the holding currency from Yahoo / CoinGecko / the supported currency
  // list. The user can override the currency manually after detection.
  const [symbolInfo, setSymbolInfo] = useState<SymbolInfo | null>(null);
  const [symbolLoading, setSymbolLoading] = useState(false);
  // Treat the saved currency as a manual override on edit-open so the
  // symbol-info auto-fill below doesn't silently rewrite it (e.g. a
  // holding saved with currency=USD and symbol=XAU would otherwise flip
  // to XAU on every open because XAU is now in the supported-currency
  // list). User can still type a new currency value in the field.
  const [currencyTouched, setCurrencyTouched] = useState(
    Boolean(initialHolding?.currency),
  );

  // Load accounts so we can show "Account currency" context, fall back
  // to it when the symbol isn't recognized, and populate the Account
  // dropdown in create mode.
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Account[]) => setAccounts(rows))
      .catch(() => {});
  }, []);

  // Edit mode: if no `initialHolding` was supplied, fetch the row from
  // the API. Surfaces that already have it (e.g. /portfolio) can skip
  // this round-trip by passing initialHolding directly.
  useEffect(() => {
    if (isCreateMode || initialHolding !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portfolio`);
        if (!res.ok) return;
        const all = (await res.json()) as Array<{
          id: number;
          accountId: number | null;
          name: string | null;
          symbol: string | null;
          currency: string | null;
          isCrypto?: number;
          note?: string;
        }>;
        const row = all.find((h) => h.id === holdingId);
        if (cancelled || !row) return;
        setForm({
          name: row.name ?? "",
          symbol: row.symbol ?? "",
          currency: row.currency ?? "CAD",
          isCrypto: row.isCrypto === 1,
          note: row.note ?? "",
          accountId: row.accountId != null ? String(row.accountId) : "",
        });
        setCurrencyTouched(Boolean(row.currency));
        setHydrated(true);
      } catch {
        // swallow — leave form in default state; user can still cancel.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [holdingId, isCreateMode, initialHolding]);

  const accountIdNum = form.accountId ? parseInt(form.accountId, 10) : NaN;
  const accountCurrency = (
    accounts.find((a) => a.id === accountIdNum)?.currency ?? ""
  ).toUpperCase();

  // Symbol-info debounce — exact behavior preserved from the original
  // HoldingEditDialog (400ms, account-currency fallback for "unknown",
  // sticky user override).
  useEffect(() => {
    if (!hydrated) return;
    const sym = form.symbol.trim().toUpperCase();
    if (!sym) {
      setSymbolInfo(null);
      // Empty symbol → cash holding. Default currency to account currency
      // when the user hasn't touched it.
      if (!currencyTouched && accountCurrency) {
        setForm((f) =>
          f.currency === accountCurrency ? f : { ...f, currency: accountCurrency },
        );
      }
      return;
    }
    let cancelled = false;
    setSymbolLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/portfolio/symbol-info?symbol=${encodeURIComponent(sym)}`,
        );
        if (!res.ok) return;
        const info = (await res.json()) as SymbolInfo;
        if (cancelled) return;
        setSymbolInfo(info);
        // Auto-fill currency: stock/etf/crypto use the detected currency;
        // unknown falls back to account currency. User overrides are sticky.
        if (!currencyTouched) {
          if (info.kind === "unknown" && accountCurrency) {
            setForm((f) =>
              f.currency === accountCurrency
                ? f
                : { ...f, currency: accountCurrency },
            );
          } else if (info.currency) {
            setForm((f) =>
              f.currency === info.currency
                ? f
                : {
                    ...f,
                    currency: info.currency!,
                    isCrypto: Boolean(info.isCrypto),
                  },
            );
          }
        }
      } finally {
        if (!cancelled) setSymbolLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [form.symbol, accountCurrency, currencyTouched, hydrated]);

  // Issue #25: tickered / cash-as-currency / "Cash"-sleeve rows have an
  // auto-managed name. The PUT handler rejects name edits on these rows,
  // so disable the input here and surface a hint instead. Reads the
  // *next* symbol (form.symbol) so toggling between a tickered position
  // and a free-text custom row immediately enables/disables the field.
  const nameAutoManaged = isCanonicalHolding(form.name, form.symbol || null);

  // Decide whether the holding-currency input is auto-derived or user-overridden.
  const currencyAutoSource: string | null =
    !currencyTouched && symbolInfo
      ? symbolInfo.kind === "unknown"
        ? `account default (${accountCurrency})`
        : `${symbolInfo.source} (${symbolInfo.kind})`
      : null;

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (isCreateMode) {
      if (!form.name.trim()) next.name = "Name is required";
      if (!form.accountId || !Number.isFinite(accountIdNum) || accountIdNum <= 0) {
        next.accountId = "Account is required";
      }
    }
    if (form.currency.trim() && !/^[A-Z]{3,4}$/.test(form.currency.trim().toUpperCase())) {
      next.currency = "Currency must be a 3-4 letter ISO 4217 code";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function save() {
    if (saving) return;
    setError("");
    setErrors({});
    if (!validate()) return;
    setSaving(true);
    try {
      const symbolValue = form.symbol.trim() ? form.symbol.trim() : null;
      const currency = form.currency.trim().toUpperCase();
      let payload: unknown;
      let method: "POST" | "PUT";
      if (isCreateMode) {
        const create = holdingCreateSchema.safeParse({
          name: form.name.trim(),
          accountId: accountIdNum,
          symbol: symbolValue,
          currency: currency || undefined,
          isCrypto: form.isCrypto,
          note: form.note,
        });
        if (!create.success) {
          // Map zod issues into per-field errors. Keep error strings as ""
          // (NOT undefined) per CLAUDE.md form-validation convention.
          const fieldErrs: Record<string, string> = {};
          for (const iss of create.error.issues) {
            const key = (iss.path[0] ?? "_") as string;
            if (!fieldErrs[key]) fieldErrs[key] = iss.message;
          }
          setErrors(fieldErrs);
          setSaving(false);
          return;
        }
        payload = create.data;
        method = "POST";
      } else {
        const update = holdingUpdateSchema.safeParse({
          id: holdingId,
          // Skip the Name field entirely on canonical rows — the PUT
          // handler would 400 on a name edit there.
          name: nameAutoManaged ? undefined : form.name.trim() || undefined,
          symbol: symbolValue,
          currency: currency || undefined,
          isCrypto: form.isCrypto ? 1 : 0,
          note: form.note,
        });
        if (!update.success) {
          const fieldErrs: Record<string, string> = {};
          for (const iss of update.error.issues) {
            const key = (iss.path[0] ?? "_") as string;
            if (!fieldErrs[key]) fieldErrs[key] = iss.message;
          }
          setErrors(fieldErrs);
          setSaving(false);
          return;
        }
        payload = update.data;
        method = "PUT";
      }
      const res = await fetch("/api/portfolio", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const holding = (await res.json()) as Record<string, unknown>;
        onSave({ kind: "saved", holding });
      } else {
        // Surface the failure cleanly — including the 423 Locked cascade
        // that fires when the session DEK isn't loaded yet (deploy
        // restart). The user gets the API's error string verbatim.
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `Save failed (HTTP ${res.status})`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (saving || holdingId === undefined) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/portfolio?id=${holdingId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          unlinkedTransactions?: number;
        };
        onSave({
          kind: "deleted",
          unlinkedTransactions: body.unlinkedTransactions ?? 0,
        });
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `Delete failed (HTTP ${res.status})`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          disabled={!isCreateMode && nameAutoManaged}
          placeholder={isCreateMode ? "e.g. Apple Inc., Bitcoin, Cash USD" : undefined}
        />
        {!isCreateMode && nameAutoManaged && (
          <p className="text-[11px] text-muted-foreground">
            Name is auto-managed for this holding type. Edit the symbol or currency to rename.
          </p>
        )}
        {errors.name && (
          <p className="text-[11px] text-rose-600 dark:text-rose-400">{errors.name}</p>
        )}
      </div>

      {isCreateMode && (
        <div className="space-y-1.5">
          <Label>Account</Label>
          <Select
            value={form.accountId}
            onValueChange={(v) => setForm({ ...form, accountId: v ?? "" })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select an account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  No accounts available
                </SelectItem>
              ) : (
                accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}{" "}
                    <span className="text-muted-foreground">({a.currency})</span>
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {errors.accountId && (
            <p className="text-[11px] text-rose-600 dark:text-rose-400">
              {errors.accountId}
            </p>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label>Symbol / ticker</Label>
        <Input
          value={form.symbol}
          onChange={(e) => setForm({ ...form, symbol: e.target.value })}
          placeholder="e.g. VCN.TO, AAPL, BTC, or a currency code (USD, EUR, XAU)"
          list="symbol-suggestions"
        />
        <datalist id="symbol-suggestions">
          {SUPPORTED_FIAT_CURRENCIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <p className="text-[11px] text-muted-foreground">
          Stock or ETF ticker (Yahoo Finance), crypto symbol, or a currency code for a cash position.
          Custom currencies you&apos;ve added in Settings are recognized here too.
        </p>
        {symbolLoading ? (
          <p className="text-[11px] text-muted-foreground">Looking up…</p>
        ) : symbolInfo ? (
          <p className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{symbolInfo.label}</span>
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label>Holding currency</Label>
        <Input
          value={form.currency}
          onChange={(e) => {
            setForm({ ...form, currency: e.target.value.toUpperCase() });
            setCurrencyTouched(true);
          }}
        />
        <p className="text-[11px] text-muted-foreground">
          {currencyAutoSource ? (
            <>
              Auto-detected from <strong>{currencyAutoSource}</strong>.{" "}
              {accountCurrency ? (
                <>
                  Account currency: <strong>{accountCurrency}</strong>.
                </>
              ) : null}{" "}
              Override if needed.
            </>
          ) : (
            <>
              The currency this holding trades / is denominated in.{" "}
              {accountCurrency ? (
                <>
                  Account currency: <strong>{accountCurrency}</strong>.
                </>
              ) : null}{" "}
              For cash positions, type the currency code in Symbol (USD, EUR, XAU…) and this will auto-fill.
            </>
          )}
        </p>
        {errors.currency && (
          <p className="text-[11px] text-rose-600 dark:text-rose-400">
            {errors.currency}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="is-crypto"
          checked={form.isCrypto}
          onChange={(e) => setForm({ ...form, isCrypto: e.target.checked })}
          className="h-4 w-4 rounded border-input"
        />
        <Label htmlFor="is-crypto" className="cursor-pointer">
          Crypto asset
        </Label>
      </div>

      <div className="space-y-1.5">
        <Label>Note</Label>
        <Input
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {!isCreateMode && deleteConfirm ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
          <p className="text-xs text-destructive flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            Delete <strong>{form.name || "(unnamed)"}</strong>? Transactions that reference this holding will stay but stop aggregating here.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setDeleteConfirm(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="flex-1"
              onClick={handleDelete}
              disabled={saving}
            >
              {saving ? "Deleting…" : "Delete holding"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 pt-1">
          {!isCreateMode && (
            <Button
              variant="outline"
              className="text-destructive border-destructive/30"
              onClick={() => setDeleteConfirm(true)}
              disabled={saving}
            >
              <Trash2 className="h-4 w-4 mr-1.5" /> Delete
            </Button>
          )}
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button className="flex-1" onClick={save} disabled={saving}>
            {saving ? "Saving…" : isCreateMode ? "Add holding" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
