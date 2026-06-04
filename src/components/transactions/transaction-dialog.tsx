"use client";

/**
 * TransactionDialog — canonical Add/Edit Transaction dialog. Owns its own
 * form state + submit logic. Used from /transactions for table create/edit
 * and from /reconcile for materialize-from-bank-row.
 *
 * Extracted from /transactions/page.tsx 2026-05-25 per plan/reuse-add-
 * transaction-dialog.md. Behavior preserved verbatim:
 *   - Transaction mode + Transfer mode (atomic both-leg pair via /api/
 *     transactions/transfer)
 *   - Edit mode: parent runs the four-check rule against linkId siblings
 *     before opening and passes `initialState.kind = 'transfer-edit'` or
 *     `'transaction-edit'` accordingly. No async flicker on open.
 *   - Prefill mode: caller provides `initialState.kind = 'transaction-
 *     prefill'` with partial form values. Used by /reconcile and (future)
 *     bulk-create flows.
 *   - Investment-account constraint: the picker hides investment accounts
 *     in new-entry mode (per CLAUDE.md "Investment accounts hidden from
 *     generic Add Transaction"). Edit-mode preserves them so legacy non-
 *     portfolio rows on investment accounts remain editable.
 *   - Live FX preview, holding-clearing effects, split editor, audit
 *     footer all behave as in the original inline dialog.
 *
 * Cross-page state coupling is exposed via callbacks rather than props:
 *   - `onRequestDelete(tx)` — Trash button in transaction-edit mode.
 *     Parent owns the confirmation modal.
 *   - `onLinkedSiblingClick(s)` — sibling button in linked-siblings panel.
 *     Parent owns navigation (table page jump etc).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { formatCurrency, formatDate } from "@/lib/currency";
import { SUPPORTED_FIAT_CURRENCIES } from "@/lib/fx/supported-currencies";
import {
  ArrowRightLeft,
  ChevronDown,
  Link2,
  Plus,
  Scissors,
  Trash2,
} from "lucide-react";
import { labelForSource, type TransactionSource } from "@/lib/tx-source";
import { safeName } from "@/lib/safe-name";

// ─── Public types ──────────────────────────────────────────────────────

export interface DialogAccount {
  id: number;
  name: string;
  currency: string;
  alias?: string | null;
  type?: string | null;
  isInvestment?: boolean;
}

export interface DialogCategory {
  id: number;
  name: string;
  type: string;
  group: string;
}

export interface DialogHolding {
  id: number;
  accountId: number | null;
  name: string;
  symbol: string | null;
  accountName: string | null;
  currentShares?: number | null;
}

export interface DialogTransaction {
  id: number;
  date: string;
  accountId: number;
  categoryId: number;
  currency: string;
  amount: number;
  enteredAmount?: number | null;
  enteredCurrency?: string | null;
  enteredFxRate?: number | null;
  quantity: number | null;
  portfolioHolding: string | null;
  note: string;
  payee: string;
  tags: string;
  isBusiness: number | null;
  linkId: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  source?: TransactionSource | null;
}

export interface DialogLinkedSibling {
  id: number;
  date: string;
  accountId: number | null;
  accountName: string | null;
  accountCurrency: string | null;
  categoryId: number | null;
  categoryName: string | null;
  categoryType: string | null;
  amount: number;
  currency: string;
  enteredAmount: number | null;
  enteredCurrency: string | null;
  enteredFxRate: number | null;
  quantity: number | null;
  portfolioHolding: string | null;
  payee: string | null;
  note: string | null;
  tags: string | null;
}

export interface TransactionFormValues {
  date: string;
  accountId: string;
  categoryId: string;
  currency: string;
  amount: string;
  payee: string;
  note: string;
  tags: string;
  isBusiness: boolean;
  quantity: string;
  portfolioHoldingId: string;
}

export type TransactionDialogInitialState =
  | {
      kind: "transaction-edit";
      tx: DialogTransaction;
      linkedSiblings?: DialogLinkedSibling[];
    }
  | {
      kind: "transfer-edit";
      debit: DialogTransaction;
      credit: DialogTransaction;
      linkId: string;
    }
  | {
      kind: "transaction-prefill";
      values: Partial<TransactionFormValues>;
      /** Optional Transfer-tab seed (reconcile materialize, 2026-06-04). When
       *  present, the Transfer tab is pre-filled from the same bank row so
       *  switching tabs no longer wipes the context. A non-empty `toAccountId`
       *  (sourced from a matched `create_transfer` rule) also opens the dialog
       *  directly in Transfer mode. */
      transferSeed?: {
        fromAccountId?: string;
        toAccountId?: string;
        date?: string;
        amount?: string;
        note?: string;
      };
    }
  | {
      /** Open in Transfer mode without any prefill (Quick-add Transfer entry). */
      kind: "transfer-create";
    };

export interface TransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: DialogAccount[];
  categories: DialogCategory[];
  holdings: DialogHolding[];
  /** Mode discriminator. Unset = plain create. */
  initialState?: TransactionDialogInitialState | null;
  /** Invoked after a successful create or update (single tx OR transfer
   *  pair). For transfer mode, `savedTxId` is the debit leg id. */
  onSaved: (
    savedTxId: number,
    ctx: { mode: "create" | "update"; isTransfer: boolean },
  ) => void | Promise<void>;
  /** Trash button in transaction-edit mode. Parent owns the confirm modal. */
  onRequestDelete?: (tx: DialogTransaction) => void;
  /** Sibling button in linked-siblings panel. Parent owns navigation. */
  onLinkedSiblingClick?: (sibling: DialogLinkedSibling) => void;
}

// ─── Internal types ────────────────────────────────────────────────────

type DialogMode = "transaction" | "transfer";

type FxPreview =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; rate: number; source: string; converted: number; date: string; to: string }
  | { state: "needs-override" }
  | { state: "error"; message: string };

interface SplitRow {
  categoryId: string;
  amount: string;
  note: string;
}

interface TransferFormState {
  date: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  receivedAmount: string;
  holdingName: string;
  destHoldingName: string;
  quantity: string;
  destQuantity: string;
  fromHoldingId: string;
  toHoldingId: string;
  note: string;
  tags: string;
}

interface TransferEditState {
  linkId: string;
  fromTxId: number;
  toTxId: number;
}

const emptySplitRow = (): SplitRow => ({ categoryId: "", amount: "", note: "" });

const FORM_DEFAULTS: TransactionFormValues = {
  date: new Date().toISOString().split("T")[0],
  accountId: "",
  categoryId: "",
  currency: "CAD",
  amount: "",
  payee: "",
  note: "",
  tags: "",
  isBusiness: false,
  quantity: "",
  portfolioHoldingId: "",
};

const TRANSFER_DEFAULTS: TransferFormState = {
  date: new Date().toISOString().split("T")[0],
  fromAccountId: "",
  toAccountId: "",
  amount: "",
  receivedAmount: "",
  holdingName: "",
  destHoldingName: "",
  quantity: "",
  destQuantity: "",
  fromHoldingId: "",
  toHoldingId: "",
  note: "",
  tags: "",
};

// ─── Component ─────────────────────────────────────────────────────────

export function TransactionDialog({
  open,
  onOpenChange,
  accounts,
  categories,
  holdings,
  initialState,
  onSaved,
  onRequestDelete,
  onLinkedSiblingClick,
}: TransactionDialogProps) {
  // Form (transaction mode)
  const [form, setForm] = useState<TransactionFormValues>(FORM_DEFAULTS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSplits, setShowSplits] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitRow[]>([emptySplitRow(), emptySplitRow()]);

  // Mode + transfer state
  const [dialogMode, setDialogMode] = useState<DialogMode>("transaction");
  const [transferForm, setTransferForm] = useState<TransferFormState>(TRANSFER_DEFAULTS);
  const [transferEdit, setTransferEdit] = useState<TransferEditState | null>(null);
  const [destHoldingTouched, setDestHoldingTouched] = useState(false);
  const [destQuantityTouched, setDestQuantityTouched] = useState(false);
  const [transferReceivedTouched, setTransferReceivedTouched] = useState(false);

  // FX preview
  const [fxPreview, setFxPreview] = useState<FxPreview>({ state: "idle" });
  const fxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [transferFxPreview, setTransferFxPreview] = useState<FxPreview>({ state: "idle" });
  const transferFxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // UI state
  const [submitError, setSubmitError] = useState<{ message: string; currency?: string } | null>(null);
  const [linkedSiblings, setLinkedSiblings] = useState<DialogLinkedSibling[]>([]);
  const [transferDeleting, setTransferDeleting] = useState(false);

  // Edit context — derived from initialState. Held in a ref so async splits
  // fetch can match it on resolve.
  const [editingTx, setEditingTx] = useState<DialogTransaction | null>(null);
  const [transferEditCredit, setTransferEditCredit] = useState<DialogTransaction | null>(null);
  const editId = editingTx?.id ?? null;

  const sortAccount = useDropdownOrder("account");
  const sortCategory = useDropdownOrder("category");
  const sortHolding = useDropdownOrder("holding");

  // ─── Seed state on open transition ──────────────────────────────────
  // Tracks the previous `open` value so we only seed on false→true edges.
  // NOTE: the false→true seeding effect is declared *below* the
  // seedFromInitialState/resetToCreateDefaults function declarations so the
  // effect closure doesn't reference them before their lexical declaration
  // (react-hooks/immutability, FINLYNQ-119). Hook call order is unchanged —
  // no hooks sit between here and that effect.
  const wasOpen = useRef(false);

  function seedFromInitialState() {
    setSubmitError(null);
    setTransferDeleting(false);
    if (!initialState) {
      resetToCreateDefaults();
      return;
    }
    if (initialState.kind === "transaction-edit") {
      const t = initialState.tx;
      setEditingTx(t);
      setTransferEditCredit(null);
      setTransferEdit(null);
      setDialogMode("transaction");
      setForm({
        date: t.date,
        accountId: String(t.accountId),
        categoryId: String(t.categoryId),
        currency: t.enteredCurrency ?? t.currency,
        amount: String(t.enteredAmount ?? t.amount),
        payee: t.payee || "",
        note: t.note || "",
        tags: t.tags || "",
        isBusiness: t.isBusiness === 1,
        quantity: t.quantity != null ? String(t.quantity) : "",
        portfolioHoldingId: t.portfolioHolding || "",
      });
      setShowAdvanced(t.isBusiness === 1 || t.quantity != null || !!t.portfolioHolding);
      setShowSplits(false);
      setSplitRows([emptySplitRow(), emptySplitRow()]);
      setLinkedSiblings(initialState.linkedSiblings ?? []);
      // Async load existing splits
      fetch(`/api/transactions/splits?transactionId=${t.id}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Array<{ categoryId: number | null; amount: number; note: string | null }>) => {
          if (Array.isArray(rows) && rows.length > 0) {
            setSplitRows(
              rows.map((r) => ({
                categoryId: r.categoryId ? String(r.categoryId) : "",
                amount: String(r.amount),
                note: r.note ?? "",
              })),
            );
            setShowSplits(true);
          }
        })
        .catch(() => {});
      return;
    }
    if (initialState.kind === "transfer-edit") {
      const { debit, credit, linkId } = initialState;
      setEditingTx(debit);
      setTransferEditCredit(credit);
      setLinkedSiblings([]);
      setDialogMode("transfer");
      setTransferEdit({ linkId, fromTxId: debit.id, toTxId: credit.id });

      const sourceLegAmount = Math.abs(debit.enteredAmount ?? debit.amount);
      const destLegAmount = Math.abs(credit.enteredAmount ?? credit.amount);
      const sourceAcct = accounts.find((a) => a.id === debit.accountId);
      const destAcct = accounts.find((a) => a.id === credit.accountId);
      const isCrossCcy = !!sourceAcct && !!destAcct && sourceAcct.currency !== destAcct.currency;

      const sourceLegHolding = debit.portfolioHolding;
      const destLegHolding = credit.portfolioHolding;
      const sourceLegQty =
        debit.quantity != null ? Math.abs(debit.quantity) : credit.quantity != null ? Math.abs(credit.quantity) : 0;
      const destLegQty = credit.quantity != null ? Math.abs(credit.quantity) : debit.quantity != null ? Math.abs(debit.quantity) : 0;
      const inKindHolding = sourceLegHolding ?? destLegHolding ?? "";
      const inKindQty = sourceLegQty || destLegQty;
      const isInKind = !!inKindHolding && inKindQty > 0;
      const destQtyDiffers = isInKind && sourceLegQty > 0 && destLegQty > 0 && Math.abs(sourceLegQty - destLegQty) > 1e-9;
      const destHoldingDiffers =
        isInKind && !!sourceLegHolding && !!destLegHolding && destLegHolding !== sourceLegHolding;

      setTransferForm({
        date: debit.date,
        fromAccountId: String(debit.accountId),
        toAccountId: String(credit.accountId),
        amount: String(sourceLegAmount),
        receivedAmount: isCrossCcy ? String(destLegAmount) : "",
        holdingName: isInKind ? inKindHolding : "",
        destHoldingName: destHoldingDiffers ? (destLegHolding ?? "") : "",
        quantity: isInKind ? String(sourceLegQty || inKindQty) : "",
        destQuantity: destQtyDiffers ? String(destLegQty) : "",
        fromHoldingId: "",
        toHoldingId: "",
        note: debit.note || credit.note || "",
        tags: debit.tags || credit.tags || "",
      });
      setDestHoldingTouched(destHoldingDiffers);
      setDestQuantityTouched(destQtyDiffers);
      // Pre-filled receivedAmount IS the canonical booked rate; mark touched
      // so the FX preview doesn't auto-overwrite with a fresh market rate.
      setTransferReceivedTouched(true);
      return;
    }
    if (initialState.kind === "transfer-create") {
      resetToCreateDefaults();
      setDialogMode("transfer");
      return;
    }
    // transaction-prefill
    resetToCreateDefaults();
    setForm((prev) => ({ ...prev, ...initialState.values }));
    // Reconcile materialize (2026-06-04): seed the Transfer tab from the same
    // bank row so switching tabs keeps the date/amount/source account, and
    // open in Transfer mode when a rule named a destination account.
    const seed = initialState.transferSeed;
    if (seed) {
      setTransferForm((tf) => ({
        ...tf,
        ...(seed.fromAccountId != null ? { fromAccountId: seed.fromAccountId } : {}),
        ...(seed.toAccountId != null ? { toAccountId: seed.toAccountId } : {}),
        ...(seed.date != null ? { date: seed.date } : {}),
        ...(seed.amount != null ? { amount: seed.amount } : {}),
        ...(seed.note != null ? { note: seed.note } : {}),
      }));
      if (seed.toAccountId) {
        setDialogMode("transfer");
      }
    }
  }

  function resetToCreateDefaults() {
    setEditingTx(null);
    setTransferEditCredit(null);
    setTransferEdit(null);
    setDialogMode("transaction");
    setForm({
      ...FORM_DEFAULTS,
      date: new Date().toISOString().split("T")[0],
    });
    setShowAdvanced(false);
    setShowSplits(false);
    setSplitRows([emptySplitRow(), emptySplitRow()]);
    setTransferForm({
      ...TRANSFER_DEFAULTS,
      date: new Date().toISOString().split("T")[0],
    });
    setTransferReceivedTouched(false);
    setDestHoldingTouched(false);
    setDestQuantityTouched(false);
    setTransferFxPreview({ state: "idle" });
    setLinkedSiblings([]);
  }

  // Seed on the false→true `open` edge. Declared after the two seed helpers
  // above so the effect closure references them post-declaration (FINLYNQ-119).
  useEffect(() => {
    if (open && !wasOpen.current) {
      seedFromInitialState();
    }
    wasOpen.current = open;
    // initialState changes are picked up at next open transition; we don't
    // want a mid-edit re-seed to wipe user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset received-touched flag whenever the user types a new source amount in
  // cross-currency transfer mode (allows FX preview to refill the dest).
  // This is mirrored inside the input's onChange but lifted here for clarity.

  // Clear per-side holding state when an account transitions away from
  // investment (full behavior preserved from the original inline dialog).
  const prevFromIsInvestmentRef = useRef(false);
  const prevToIsInvestmentRef = useRef(false);
  useEffect(() => {
    const fromAcct = accounts.find((a) => String(a.id) === transferForm.fromAccountId);
    const toAcct = accounts.find((a) => String(a.id) === transferForm.toAccountId);
    const fromIsInvestment = fromAcct?.isInvestment === true;
    const toIsInvestment = toAcct?.isInvestment === true;

    if (prevFromIsInvestmentRef.current && !fromIsInvestment) {
      setTransferForm((tf) => ({
        ...tf,
        fromHoldingId: "",
        holdingName: "",
        quantity: "",
      }));
    }
    if (prevToIsInvestmentRef.current && !toIsInvestment) {
      setTransferForm((tf) => ({
        ...tf,
        toHoldingId: "",
        destHoldingName: "",
        destQuantity: "",
      }));
      setDestHoldingTouched(false);
      setDestQuantityTouched(false);
    }
    if (
      !fromIsInvestment &&
      !toIsInvestment &&
      (prevFromIsInvestmentRef.current || prevToIsInvestmentRef.current)
    ) {
      setTransferForm((tf) => ({
        ...tf,
        holdingName: "",
        destHoldingName: "",
        quantity: "",
        destQuantity: "",
        fromHoldingId: "",
        toHoldingId: "",
      }));
      setDestHoldingTouched(false);
      setDestQuantityTouched(false);
    }

    prevFromIsInvestmentRef.current = fromIsInvestment;
    prevToIsInvestmentRef.current = toIsInvestment;
  }, [transferForm.fromAccountId, transferForm.toAccountId, accounts]);

  // ─── FX preview (transaction mode) ──────────────────────────────────
  useEffect(() => {
    if (fxTimer.current) clearTimeout(fxTimer.current);
    if (!open) {
      setFxPreview({ state: "idle" });
      return;
    }
    const acct = accounts.find((a) => String(a.id) === form.accountId);
    const accountCurrency = acct?.currency;
    const amountNum = parseFloat(form.amount);
    if (
      !accountCurrency ||
      !form.currency ||
      !form.amount ||
      !Number.isFinite(amountNum) ||
      amountNum === 0 ||
      form.currency === accountCurrency
    ) {
      setFxPreview({ state: "idle" });
      return;
    }
    setFxPreview({ state: "loading" });
    fxTimer.current = setTimeout(() => {
      const params = new URLSearchParams({
        from: form.currency,
        to: accountCurrency,
        date: form.date,
        amount: String(Math.abs(amountNum)),
      });
      fetch(`/api/fx/preview?${params}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            setFxPreview({ state: "error", message: d?.error ?? "Rate lookup failed" });
            return;
          }
          if (d?.needsOverride === true) {
            setFxPreview({ state: "needs-override" });
            return;
          }
          const sign = amountNum < 0 ? -1 : 1;
          setFxPreview({
            state: "ok",
            rate: Number(d.rate ?? 0),
            source: String(d.source ?? "—"),
            converted: sign * Number(d.converted ?? 0),
            date: String(d.date ?? form.date),
            to: accountCurrency,
          });
        })
        .catch((e) => setFxPreview({ state: "error", message: String(e?.message ?? "Network error") }));
    }, 300);
    return () => {
      if (fxTimer.current) clearTimeout(fxTimer.current);
    };
  }, [open, form.accountId, form.amount, form.currency, form.date, accounts]);

  // ─── FX preview (transfer mode) ─────────────────────────────────────
  useEffect(() => {
    if (transferFxTimer.current) clearTimeout(transferFxTimer.current);
    if (!open || dialogMode !== "transfer") {
      setTransferFxPreview({ state: "idle" });
      return;
    }
    const fromAcct = accounts.find((a) => String(a.id) === transferForm.fromAccountId);
    const toAcct = accounts.find((a) => String(a.id) === transferForm.toAccountId);
    const amountNum = parseFloat(transferForm.amount);
    if (
      !fromAcct ||
      !toAcct ||
      !transferForm.amount ||
      !Number.isFinite(amountNum) ||
      amountNum <= 0 ||
      fromAcct.currency === toAcct.currency
    ) {
      setTransferFxPreview({ state: "idle" });
      return;
    }
    setTransferFxPreview({ state: "loading" });
    transferFxTimer.current = setTimeout(() => {
      const params = new URLSearchParams({
        from: fromAcct.currency,
        to: toAcct.currency,
        date: transferForm.date,
        amount: String(amountNum),
      });
      fetch(`/api/fx/preview?${params}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            setTransferFxPreview({ state: "error", message: d?.error ?? "Rate lookup failed" });
            return;
          }
          if (d?.needsOverride === true) {
            setTransferFxPreview({ state: "needs-override" });
            return;
          }
          const converted = Number(d.converted ?? 0);
          setTransferFxPreview({
            state: "ok",
            rate: Number(d.rate ?? 0),
            source: String(d.source ?? "—"),
            converted,
            date: String(d.date ?? transferForm.date),
            to: toAcct.currency,
          });
          if (!transferReceivedTouched) {
            setTransferForm((tf) => ({ ...tf, receivedAmount: converted.toFixed(2) }));
          }
        })
        .catch((e) => setTransferFxPreview({ state: "error", message: String(e?.message ?? "Network error") }));
    }, 300);
    return () => {
      if (transferFxTimer.current) clearTimeout(transferFxTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dialogMode, transferForm.fromAccountId, transferForm.toAccountId, transferForm.amount, transferForm.date, accounts]);

  // ─── Handlers ───────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (!form.accountId) {
      setSubmitError({ message: "Pick an account" });
      return;
    }
    if (!form.categoryId) {
      setSubmitError({ message: "Pick a category" });
      return;
    }
    if (!form.amount || Number.isNaN(parseFloat(form.amount))) {
      setSubmitError({ message: "Enter an amount" });
      return;
    }
    const sel = accounts.find((a) => String(a.id) === form.accountId);
    if (sel?.isInvestment === true && !form.portfolioHoldingId) {
      setSubmitError({ message: `Pick a portfolio holding — ${sel.name} is an investment account.` });
      return;
    }

    const body: Record<string, unknown> = {
      ...(editId ? { id: editId } : {}),
      date: form.date,
      accountId: Number(form.accountId),
      categoryId: Number(form.categoryId),
      enteredCurrency: form.currency,
      enteredAmount: parseFloat(form.amount),
      payee: form.payee,
      note: form.note,
      tags: form.tags,
      isBusiness: form.isBusiness ? 1 : 0,
    };
    if (form.quantity) body.quantity = parseFloat(form.quantity);
    if (form.portfolioHoldingId) body.portfolioHolding = form.portfolioHoldingId;

    const res = await fetch("/api/transactions", {
      method: editId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data?.code === "fx-currency-needs-override") {
        setSubmitError({
          message: `No FX rate for ${data.currency ?? form.currency}.`,
          currency: data.currency ?? form.currency,
        });
      } else {
        setSubmitError({ message: data?.error ?? `Save failed (${res.status})` });
      }
      return;
    }

    let savedTxId = editId;
    if (!savedTxId && res.ok) {
      const created = await res.json();
      savedTxId = created.id;
    }

    if (showSplits && splitRows.filter((r) => r.amount).length >= 2 && savedTxId) {
      const sign = parseFloat(form.amount) < 0 ? -1 : 1;
      await fetch("/api/transactions/splits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionId: savedTxId,
          splits: splitRows
            .filter((r) => r.amount)
            .map((r) => ({
              categoryId: r.categoryId ? parseInt(r.categoryId) : null,
              amount: sign * Math.abs(parseFloat(r.amount) || 0),
              note: r.note,
            })),
        }),
      });
    }

    if (savedTxId) {
      await onSaved(savedTxId, {
        mode: editId ? "update" : "create",
        isTransfer: false,
      });
    }
    onOpenChange(false);
  }

  async function handleTransferSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const fromAccountId = Number(transferForm.fromAccountId);
    const toAccountId = Number(transferForm.toAccountId);
    if (!fromAccountId || !toAccountId) {
      setSubmitError({ message: "Pick both a source and destination account" });
      return;
    }

    const fromAcctCheck = accounts.find((a) => a.id === fromAccountId);
    const toAcctCheck = accounts.find((a) => a.id === toAccountId);
    const bothInv = fromAcctCheck?.isInvestment === true && toAcctCheck?.isInvestment === true;
    if (fromAccountId === toAccountId && !bothInv) {
      setSubmitError({ message: "From and To accounts must differ for a cash transfer" });
      return;
    }

    const enteredAmount = parseFloat(transferForm.amount || "0");
    const isInKind = bothInv;
    let quantityNum: number | undefined;
    let holdingName: string | undefined;
    if (isInKind) {
      holdingName = transferForm.holdingName.trim();
      if (!holdingName) {
        setSubmitError({ message: "Pick a holding for the in-kind transfer" });
        return;
      }
      const q = parseFloat(transferForm.quantity);
      if (!Number.isFinite(q) || q <= 0) {
        setSubmitError({ message: "Quantity must be a positive number for an in-kind transfer" });
        return;
      }
      quantityNum = q;
      if (!Number.isFinite(enteredAmount) || enteredAmount < 0) {
        setSubmitError({ message: "Cash amount must be 0 or a positive number" });
        return;
      }
    } else {
      if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
        setSubmitError({ message: "Amount must be a positive number" });
        return;
      }
    }

    const fromAcct = fromAcctCheck;
    const toAcct = toAcctCheck;
    const isCrossCcy = !!fromAcct && !!toAcct && fromAcct.currency !== toAcct.currency;

    let fromHoldingPin: number | undefined;
    let toHoldingPin: number | undefined;
    let singleSideQuantity: number | undefined;
    if (!isInKind) {
      if (fromAcct?.isInvestment === true) {
        if (!transferForm.fromHoldingId) {
          setSubmitError({ message: `Pick a source holding — ${fromAcct.name} is an investment account.` });
          return;
        }
        fromHoldingPin = Number(transferForm.fromHoldingId);
      }
      if (toAcct?.isInvestment === true) {
        if (!transferForm.toHoldingId) {
          setSubmitError({ message: `Pick a destination holding — ${toAcct.name} is an investment account.` });
          return;
        }
        toHoldingPin = Number(transferForm.toHoldingId);
      }
      if (!transferEdit && (fromHoldingPin != null || toHoldingPin != null)) {
        const q = parseFloat(transferForm.quantity);
        if (!Number.isFinite(q) || q <= 0) {
          setSubmitError({
            message: "Quantity (shares) must be a positive number for an investment-account transfer",
          });
          return;
        }
        singleSideQuantity = q;
      }
    }

    let receivedAmount: number | undefined;
    if (isCrossCcy && transferForm.receivedAmount) {
      const parsed = parseFloat(transferForm.receivedAmount);
      if (Number.isFinite(parsed) && parsed >= 0) receivedAmount = parsed;
    }

    const body: Record<string, unknown> = {
      fromAccountId,
      toAccountId,
      enteredAmount,
      date: transferForm.date,
      ...(receivedAmount != null ? { receivedAmount } : {}),
      ...(fromHoldingPin != null ? { fromHoldingId: fromHoldingPin } : {}),
      ...(toHoldingPin != null ? { toHoldingId: toHoldingPin } : {}),
      ...(singleSideQuantity != null ? { quantity: singleSideQuantity } : {}),
      ...(transferForm.note ? { note: transferForm.note } : {}),
      ...(transferForm.tags ? { tags: transferForm.tags } : {}),
      ...(transferEdit ? { linkId: transferEdit.linkId } : {}),
    };

    const isEdit = !!transferEdit;
    if (isInKind) {
      body.holdingName = holdingName;
      body.quantity = quantityNum;
      const destOverride = transferForm.destHoldingName.trim();
      if (destOverride && destOverride !== holdingName) {
        body.destHoldingName = destOverride;
      } else if (isEdit) {
        body.destHoldingName = null;
      }
      const destQtyRaw = transferForm.destQuantity.trim();
      if (destQuantityTouched && destQtyRaw) {
        const parsed = parseFloat(destQtyRaw);
        if (Number.isFinite(parsed) && parsed > 0 && parsed !== quantityNum) {
          body.destQuantity = parsed;
        } else if (isEdit) {
          body.destQuantity = null;
        }
      } else if (isEdit) {
        body.destQuantity = null;
      }
    } else if (isEdit) {
      body.holdingName = null;
      body.destHoldingName = null;
      body.quantity = null;
      body.destQuantity = null;
    }

    const res = await fetch("/api/transactions/transfer", {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data?.code === "fx-currency-needs-override") {
        setSubmitError({
          message: `No FX rate for ${data.currency ?? toAcct?.currency ?? "destination currency"}.`,
          currency: data.currency,
        });
      } else {
        setSubmitError({ message: data?.error ?? `Save failed (${res.status})` });
      }
      return;
    }

    // Best-effort: return the debit leg id when we can recover it from the
    // server response, else fall back to the existing edit-pair fromTxId.
    let debitTxId = transferEdit?.fromTxId ?? 0;
    try {
      const created = await res.clone().json();
      // `/api/transactions/transfer` returns `fromTransactionId` (the debit
      // leg). Read it first so the reconcile materialize flow can auto-link
      // the bank row to that leg; `fromTxId`/`id` kept as defensive fallbacks.
      if (typeof created?.fromTransactionId === "number") debitTxId = created.fromTransactionId;
      else if (typeof created?.fromTxId === "number") debitTxId = created.fromTxId;
      else if (typeof created?.id === "number") debitTxId = created.id;
    } catch {
      /* response may not have JSON body — ignore */
    }
    await onSaved(debitTxId, {
      mode: isEdit ? "update" : "create",
      isTransfer: true,
    });
    onOpenChange(false);
  }

  async function handleTransferDelete() {
    if (!transferEdit) return;
    setTransferDeleting(true);
    try {
      await fetch(`/api/transactions/transfer?linkId=${encodeURIComponent(transferEdit.linkId)}`, {
        method: "DELETE",
      });
    } finally {
      setTransferDeleting(false);
    }
    await onSaved(transferEdit.fromTxId, { mode: "update", isTransfer: true });
    onOpenChange(false);
  }

  // ─── Computed ───────────────────────────────────────────────────────
  const splitAllocated = useMemo(
    () => splitRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
    [splitRows],
  );
  const splitRemaining = Math.abs(parseFloat(form.amount) || 0) - splitAllocated;
  const splitBalanced = Math.abs(splitRemaining) < 0.01;

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setEditingTx(null);
          setTransferEditCredit(null);
          setDialogMode("transaction");
          setSubmitError(null);
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {dialogMode === "transfer"
              ? editId
                ? "Edit Transfer"
                : "New Transfer"
              : editId
                ? "Edit Transaction"
                : "New Transaction"}
          </DialogTitle>
        </DialogHeader>

        {!editId && (
          <div className="inline-flex rounded-md border bg-muted/40 p-0.5 self-start">
            <button
              type="button"
              onClick={() => {
                setDialogMode("transaction");
                setSubmitError(null);
              }}
              className={`px-3 py-1 text-sm rounded transition-colors ${dialogMode === "transaction" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              Transaction
            </button>
            <button
              type="button"
              onClick={() => {
                setDialogMode("transfer");
                setSubmitError(null);
              }}
              className={`px-3 py-1 text-sm rounded transition-colors flex items-center gap-1.5 ${dialogMode === "transfer" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              <ArrowRightLeft className="h-3.5 w-3.5" /> Transfer
            </button>
          </div>
        )}

        {dialogMode === "transaction" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Amount</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  placeholder="-50.00"
                  required
                />
              </div>
            </div>
            {fxPreview.state !== "idle" && (
              <div className="text-xs text-muted-foreground -mt-2">
                {fxPreview.state === "loading" && <span>Loading…</span>}
                {fxPreview.state === "ok" && (
                  <span>
                    Account:{" "}
                    <span className="font-mono font-medium text-foreground">
                      {formatCurrency(fxPreview.converted, fxPreview.to)}
                    </span>
                    <span className="ml-1.5 opacity-70">
                      (rate {fxPreview.rate} · {fxPreview.source} · {fxPreview.date})
                    </span>
                  </span>
                )}
                {fxPreview.state === "needs-override" && (
                  <span className="text-amber-600 dark:text-amber-400">
                    Rate not available —{" "}
                    <Link href="/settings/general" className="underline hover:no-underline">
                      add an override
                    </Link>
                    .
                  </span>
                )}
                {fxPreview.state === "error" && (
                  <span className="text-rose-600 dark:text-rose-400">{fxPreview.message}</span>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Account</Label>
                <Combobox
                  value={form.accountId}
                  onValueChange={(v) => {
                    const acct = accounts.find((a) => String(a.id) === v);
                    const stillValid = form.portfolioHoldingId
                      ? holdings.some(
                          (h) => h.name === form.portfolioHoldingId && String(h.accountId) === v,
                        )
                      : true;
                    setForm({
                      ...form,
                      accountId: v,
                      currency: acct?.currency ?? "CAD",
                      portfolioHoldingId: stillValid ? form.portfolioHoldingId : "",
                    });
                  }}
                  items={sortAccount(
                    accounts
                      .filter((a) => !!editId || a.isInvestment !== true)
                      .map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name })),
                    (a) => Number(a.value),
                    (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                  )}
                  placeholder="Select account"
                  searchPlaceholder="Search accounts…"
                  emptyMessage="No matches"
                  className="w-full"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Combobox
                  value={form.categoryId}
                  onValueChange={(v) => setForm({ ...form, categoryId: v })}
                  items={sortCategory(
                    categories.map((c): ComboboxItemShape => ({
                      value: String(c.id),
                      label: `${c.group} - ${c.name}`,
                    })),
                    (c) => Number(c.value),
                    (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                  )}
                  placeholder="Select category"
                  searchPlaceholder="Search categories…"
                  emptyMessage="No matches"
                  className="w-full"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Payee</Label>
                <Input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v ?? "CAD" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_FIAT_CURRENCIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Note</Label>
              <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Tags (comma-separated)</Label>
              <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
            </div>

            {(() => {
              const sel = accounts.find((a) => String(a.id) === form.accountId);
              if (sel?.isInvestment !== true) return null;
              const accountHoldings = holdings.filter((h) => h.accountId === sel.id);
              const cash = accountHoldings.find((h) => !h.symbol);
              const items: ComboboxItemShape[] = [
                ...(cash
                  ? [{ value: cash.name, label: `${cash.name} (auto) — cash sleeve` } satisfies ComboboxItemShape]
                  : []),
                ...sortHolding(
                  accountHoldings
                    .filter((h) => h !== cash)
                    .map((h): ComboboxItemShape => ({
                      value: h.name,
                      label: h.symbol ? `${h.name} (${h.symbol})` : h.name,
                    })),
                  (h) => accountHoldings.find((x) => x.name === h.value)?.id ?? h.value,
                  (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                ),
              ];
              return (
                <div className="space-y-1.5 rounded-md border border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20 p-3">
                  <Label>
                    Portfolio Holding <span className="text-rose-600">*</span>
                  </Label>
                  <Combobox
                    value={form.portfolioHoldingId}
                    onValueChange={(v) => setForm({ ...form, portfolioHoldingId: v })}
                    items={items}
                    placeholder={cash ? "Cash (auto)" : "Pick a holding"}
                    searchPlaceholder="Search holdings…"
                    emptyMessage="No matches"
                    className="w-full"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {sel.name} is an investment account — every transaction must reference a holding. Pick the symbol you traded, or leave the default Cash sleeve for cash legs (deposits, fees, dividends paid as cash).
                  </p>
                </div>
              );
            })()}

            {editId && linkedSiblings.length > 0 && (
              <div className="space-y-2 rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50/50 dark:bg-sky-950/30 p-3">
                <div className="text-[11px] text-sky-700/80 dark:text-sky-300/80">
                  This transaction is part of a multi-leg group; legs are edited individually.
                </div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-300">
                  <Link2 className="h-3.5 w-3.5" />
                  Linked transaction{linkedSiblings.length > 1 ? "s" : ""}
                </div>
                <div className="space-y-1">
                  {linkedSiblings.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => onLinkedSiblingClick?.(s)}
                      className="flex w-full items-center justify-between gap-2 rounded-md bg-background/50 px-2 py-1.5 text-xs hover:bg-background transition-colors border border-transparent hover:border-sky-200 dark:hover:border-sky-800"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-muted-foreground font-mono shrink-0">{formatDate(s.date)}</span>
                        <span className="truncate font-medium">{s.accountName ?? "—"}</span>
                        {s.portfolioHolding && (
                          <span className="text-muted-foreground truncate">· {s.portfolioHolding}</span>
                        )}
                      </div>
                      <span
                        className={`font-mono font-semibold shrink-0 ${s.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}
                      >
                        {formatCurrency(s.amount, s.currency)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
              onClick={() => setShowSplits(!showSplits)}
            >
              <Scissors className={`h-4 w-4 transition-transform ${showSplits ? "text-violet-500" : ""}`} />
              {showSplits ? "Hide splits" : "Split this transaction"}
            </button>

            {showSplits && (
              <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
                <div className="text-xs text-muted-foreground font-medium">
                  Split rows (must sum to total amount)
                </div>
                {splitRows.map((row, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <Combobox
                      value={row.categoryId}
                      onValueChange={(v) => {
                        const next = [...splitRows];
                        next[i] = { ...next[i], categoryId: v };
                        setSplitRows(next);
                      }}
                      items={sortCategory(
                        categories.map((c): ComboboxItemShape => ({
                          value: String(c.id),
                          label: c.name,
                        })),
                        (c) => Number(c.value),
                        (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                      )}
                      placeholder="Category"
                      searchPlaceholder="Search categories…"
                      emptyMessage="No matches"
                      size="sm"
                      className="h-7 flex-1 text-xs"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      className="h-7 text-xs w-24 font-mono"
                      placeholder="0.00"
                      value={row.amount}
                      onChange={(e) => {
                        const next = [...splitRows];
                        next[i] = { ...next[i], amount: e.target.value };
                        setSplitRows(next);
                      }}
                    />
                    <Input
                      className="h-7 text-xs w-24"
                      placeholder="Note"
                      value={row.note}
                      onChange={(e) => {
                        const next = [...splitRows];
                        next[i] = { ...next[i], note: e.target.value };
                        setSplitRows(next);
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground"
                      onClick={() => setSplitRows(splitRows.filter((_, j) => j !== i))}
                      disabled={splitRows.length <= 2}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={() => setSplitRows([...splitRows, emptySplitRow()])}
                >
                  <Plus className="h-3 w-3 mr-1" /> Add row
                </Button>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    Allocated:{" "}
                    <span className="font-mono">{formatCurrency(splitAllocated, form.currency)}</span>
                  </span>
                  {splitBalanced ? (
                    <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-600 bg-emerald-50">
                      Balanced
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] border-rose-300 text-rose-600 bg-rose-50">
                      {splitRemaining > 0
                        ? `${formatCurrency(splitRemaining, form.currency)} left`
                        : `${formatCurrency(Math.abs(splitRemaining), form.currency)} over`}
                    </Badge>
                  )}
                </div>
              </div>
            )}

            <button
              type="button"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
              Advanced Options
            </button>

            {showAdvanced && (
              <div className="space-y-4 border rounded-lg p-4 bg-muted/20">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Quantity</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      value={form.quantity}
                      onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                      placeholder="e.g. 10"
                    />
                  </div>
                  {accounts.find((a) => String(a.id) === form.accountId)?.isInvestment !== true && (
                    <div className="space-y-1.5">
                      <Label>Portfolio Holding</Label>
                      <Combobox
                        value={form.portfolioHoldingId}
                        onValueChange={(v) => setForm({ ...form, portfolioHoldingId: v })}
                        items={(() => {
                          const accountHoldings = form.accountId
                            ? holdings.filter((h) => String(h.accountId) === form.accountId)
                            : holdings;
                          return [
                            ...sortHolding(
                              accountHoldings.map((h): ComboboxItemShape => ({
                                value: h.name,
                                label: `${h.symbol ? `${h.name} (${h.symbol})` : h.name}${h.accountName ? ` — ${h.accountName}` : ""}`,
                              })),
                              (h) => accountHoldings.find((x) => x.name === h.value)?.id ?? h.value,
                              (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                            ),
                            ...(form.portfolioHoldingId &&
                            !holdings.some((h) => h.name === form.portfolioHoldingId)
                              ? [
                                  {
                                    value: form.portfolioHoldingId,
                                    label: form.portfolioHoldingId,
                                  } satisfies ComboboxItemShape,
                                ]
                              : []),
                          ];
                        })()}
                        placeholder="None"
                        searchPlaceholder="Search holdings…"
                        emptyMessage="No matches"
                        className="w-full"
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="isBusiness"
                    checked={form.isBusiness}
                    onChange={(e) => setForm({ ...form, isBusiness: e.target.checked })}
                    className="h-4 w-4 rounded border-input"
                  />
                  <Label htmlFor="isBusiness" className="cursor-pointer">
                    Business expense
                  </Label>
                </div>
              </div>
            )}

            {submitError && (
              <div className="rounded-md border border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                {submitError.message}{" "}
                {submitError.currency && (
                  <Link href="/settings/general" className="underline hover:no-underline">
                    Add a custom rate
                  </Link>
                )}
              </div>
            )}

            {editingTx && (() => {
              const created = editingTx.createdAt ? new Date(editingTx.createdAt).toLocaleString() : null;
              const updated = editingTx.updatedAt ? new Date(editingTx.updatedAt).toLocaleString() : null;
              const sourceLabel = editingTx.source ? labelForSource(editingTx.source) : null;
              if (!created && !updated && !sourceLabel) return null;
              return (
                <div className="text-[11px] text-muted-foreground border-t pt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {created && <span>Created {created}</span>}
                  {updated && <span>· Updated {updated}</span>}
                  {sourceLabel && (
                    <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                      {sourceLabel}
                    </Badge>
                  )}
                </div>
              );
            })()}

            <div className="flex gap-2">
              {editingTx && onRequestDelete && (
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive border-destructive/30"
                  onClick={() => {
                    onRequestDelete(editingTx);
                    onOpenChange(false);
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" /> Delete
                </Button>
              )}
              <Button type="submit" className="flex-1">
                {editId ? "Update" : "Create"} Transaction
              </Button>
            </div>
          </form>
        )}

        {dialogMode === "transfer" && (
          <form onSubmit={handleTransferSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={transferForm.date}
                  onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Amount sent</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={transferForm.amount}
                  onChange={(e) => {
                    setTransferReceivedTouched(false);
                    setTransferForm({ ...transferForm, amount: e.target.value });
                  }}
                  placeholder="100.00"
                  required
                />
              </div>
            </div>
            {(() => {
              const fromAcctPicker = accounts.find((a) => String(a.id) === transferForm.fromAccountId);
              const toAcctPicker = accounts.find((a) => String(a.id) === transferForm.toAccountId);
              const fromIsInv = fromAcctPicker?.isInvestment === true;
              const toIsInv = toAcctPicker?.isInvestment === true;
              const allowSameAccount =
                (fromIsInv && toIsInv) ||
                (fromIsInv && !toAcctPicker) ||
                (!fromAcctPicker && toIsInv);
              return (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>From account</Label>
                    <Combobox
                      value={transferForm.fromAccountId}
                      onValueChange={(v) => setTransferForm({ ...transferForm, fromAccountId: v })}
                      items={sortAccount(
                        accounts
                          .filter((a) => !!editId || a.isInvestment !== true)
                          .filter((a) => allowSameAccount || String(a.id) !== transferForm.toAccountId)
                          .map((a): ComboboxItemShape => ({
                            value: String(a.id),
                            label: `${a.name} · ${a.currency}`,
                          })),
                        (a) => Number(a.value),
                        (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                      )}
                      placeholder="Source account"
                      searchPlaceholder="Search accounts…"
                      emptyMessage="No matches"
                      className="w-full"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>To account</Label>
                    <Combobox
                      value={transferForm.toAccountId}
                      onValueChange={(v) => setTransferForm({ ...transferForm, toAccountId: v })}
                      items={sortAccount(
                        accounts
                          .filter((a) => !!editId || a.isInvestment !== true)
                          .filter((a) => allowSameAccount || String(a.id) !== transferForm.fromAccountId)
                          .map((a): ComboboxItemShape => ({
                            value: String(a.id),
                            label: `${a.name} · ${a.currency}`,
                          })),
                        (a) => Number(a.value),
                        (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                      )}
                      placeholder="Destination account"
                      searchPlaceholder="Search accounts…"
                      emptyMessage="No matches"
                      className="w-full"
                    />
                  </div>
                </div>
              );
            })()}

            {(() => {
              const fromAcct = accounts.find((a) => String(a.id) === transferForm.fromAccountId);
              const toAcct = accounts.find((a) => String(a.id) === transferForm.toAccountId);
              const fromInv = fromAcct?.isInvestment === true;
              const toInv = toAcct?.isInvestment === true;
              if (!fromInv && !toInv) return null;

              const bothInv = fromInv && toInv;

              const sourceHoldings = fromAcct ? holdings.filter((h) => h.accountId === fromAcct.id) : [];
              const destHoldings = toAcct ? holdings.filter((h) => h.accountId === toAcct.id) : [];

              const buildHoldingItems = (acctHoldings: typeof holdings): ComboboxItemShape[] =>
                sortHolding(
                  acctHoldings.map((h): ComboboxItemShape => ({
                    value: bothInv ? h.name : String(h.id),
                    label: h.symbol ? `${h.name} (${h.symbol})` : h.name,
                  })),
                  (h) =>
                    acctHoldings.find((x) => (bothInv ? x.name === h.value : String(x.id) === h.value))?.id ?? h.value,
                  (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                );

              if (bothInv) {
                const sourceName = transferForm.holdingName.trim();
                const destExactMatch =
                  sourceName !== "" ? destHoldings.find((h) => h.name === sourceName) ?? null : null;
                const destSentinel = "__same_as_source__";
                const destSelectValue =
                  transferForm.destHoldingName.trim() !== "" &&
                  transferForm.destHoldingName.trim() !== sourceName
                    ? transferForm.destHoldingName.trim()
                    : destSentinel;
                return (
                  <div className="space-y-3 rounded-md border border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20 p-3">
                    <p className="text-[11px] text-muted-foreground">
                      Both accounts are investment accounts — pick the holding to transfer and the quantity. Source holding must already exist. Destination defaults to the same holding name (auto-created if missing). Cash amount may be 0 for a pure in-kind move.
                    </p>
                    {fromAcct && toAcct && fromAcct.id === toAcct.id && (
                      <p className="text-[11px] text-amber-700 dark:text-amber-300">
                        Same-account rebalance — pick a different destination holding to move shares between two positions in this brokerage.
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">
                          Source holding (in {fromAcct?.name ?? "—"}){" "}
                          <span className="text-rose-600">*</span>
                        </Label>
                        <Combobox
                          value={transferForm.holdingName}
                          onValueChange={(v) => setTransferForm({ ...transferForm, holdingName: v ?? "" })}
                          items={buildHoldingItems(sourceHoldings)}
                          placeholder="Pick a holding"
                          searchPlaceholder="Search holdings…"
                          emptyMessage="No matches"
                          size="sm"
                          className="w-full"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">
                          Quantity (shares) <span className="text-rose-600">*</span>
                        </Label>
                        <Input
                          type="number"
                          step="0.0001"
                          min="0"
                          value={transferForm.quantity}
                          onChange={(e) => setTransferForm({ ...transferForm, quantity: e.target.value })}
                          placeholder="e.g. 10.0000"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Destination holding (in {toAcct?.name ?? "—"})</Label>
                        {toAcct ? (
                          <Select
                            value={destSelectValue}
                            onValueChange={(v) => {
                              const val = v ?? destSentinel;
                              if (val === destSentinel) {
                                setDestHoldingTouched(false);
                                setTransferForm({ ...transferForm, destHoldingName: "" });
                              } else if (val === "__custom__") {
                                setDestHoldingTouched(true);
                              } else {
                                setDestHoldingTouched(true);
                                setTransferForm({ ...transferForm, destHoldingName: val });
                              }
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Same as source">
                                {(v) => {
                                  const val = v == null ? "" : String(v);
                                  if (!val || val === destSentinel) {
                                    if (!sourceName) return "Same as source";
                                    const matchShares = Number(destExactMatch?.currentShares ?? 0);
                                    return destExactMatch
                                      ? `${sourceName} (existing · ${matchShares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares)`
                                      : `${sourceName} (will create)`;
                                  }
                                  if (val === "__custom__") return transferForm.destHoldingName || "Custom name";
                                  const h = destHoldings.find((x) => x.name === val);
                                  const shares = Number(h?.currentShares ?? 0);
                                  return `${val} · ${shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares`;
                                }}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={destSentinel}>
                                {sourceName
                                  ? destExactMatch
                                    ? `Same as source — binds to existing "${sourceName}" (${Number(
                                        destExactMatch.currentShares ?? 0,
                                      ).toLocaleString(undefined, { maximumFractionDigits: 4 })} shares)`
                                    : `Same as source — auto-create "${sourceName}"`
                                  : "Same as source"}
                              </SelectItem>
                              {destHoldings
                                .filter((h) => h.name !== sourceName)
                                .map((h) => {
                                  const shares = Number(h.currentShares ?? 0);
                                  const qty = ` · ${shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares`;
                                  return (
                                    <SelectItem key={h.id} value={h.name}>
                                      {h.symbol ? `${h.name} (${h.symbol})${qty}` : `${h.name}${qty}`}
                                    </SelectItem>
                                  );
                                })}
                              <SelectItem value="__custom__">+ Type a different name…</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input value="" placeholder="Pick a destination account first" disabled />
                        )}
                        {destHoldingTouched && destSelectValue === "__custom__" && (
                          <Input
                            value={transferForm.destHoldingName}
                            onChange={(e) => setTransferForm({ ...transferForm, destHoldingName: e.target.value })}
                            placeholder={`New holding name in ${toAcct?.name ?? "destination"}`}
                          />
                        )}
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Destination quantity</Label>
                        <Input
                          type="number"
                          step="0.0001"
                          min="0"
                          value={destQuantityTouched ? transferForm.destQuantity : transferForm.quantity}
                          onChange={(e) => {
                            setDestQuantityTouched(true);
                            setTransferForm({ ...transferForm, destQuantity: e.target.value });
                          }}
                          placeholder={transferForm.quantity || "e.g. 10.0000"}
                        />
                        {destQuantityTouched &&
                          transferForm.destQuantity &&
                          parseFloat(transferForm.destQuantity) !== parseFloat(transferForm.quantity || "0") && (
                            <p className="text-[11px] text-amber-700 dark:text-amber-300">
                              Asymmetric — the destination will receive a different share count (split / merger / conversion).
                            </p>
                          )}
                        {destQuantityTouched && (
                          <button
                            type="button"
                            className="text-[11px] text-muted-foreground hover:text-foreground underline"
                            onClick={() => {
                              setDestQuantityTouched(false);
                              setTransferForm({ ...transferForm, destQuantity: "" });
                            }}
                          >
                            Reset to source quantity
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

              if (transferEdit) return null;
              return (
                <div className="space-y-2 rounded-md border border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20 p-3">
                  <p className="text-[11px] text-muted-foreground">
                    Investment account leg — every transfer into an investment account must reference a holding and the share count moving through it.
                  </p>
                  {fromInv && fromAcct && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">
                          Holding in {fromAcct.name} <span className="text-rose-600">*</span>
                        </Label>
                        <Combobox
                          value={transferForm.fromHoldingId}
                          onValueChange={(v) => setTransferForm({ ...transferForm, fromHoldingId: v ?? "" })}
                          items={buildHoldingItems(sourceHoldings)}
                          placeholder="Pick a holding"
                          searchPlaceholder="Search holdings…"
                          emptyMessage="No matches"
                          size="sm"
                          className="w-full"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">
                          Quantity (shares) <span className="text-rose-600">*</span>
                        </Label>
                        <Input
                          type="number"
                          step="0.0001"
                          min="0"
                          value={transferForm.quantity}
                          onChange={(e) => setTransferForm({ ...transferForm, quantity: e.target.value })}
                          placeholder="e.g. 10.0000"
                        />
                      </div>
                    </div>
                  )}
                  {toInv && toAcct && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">
                          Holding in {toAcct.name} <span className="text-rose-600">*</span>
                        </Label>
                        <Combobox
                          value={transferForm.toHoldingId}
                          onValueChange={(v) => setTransferForm({ ...transferForm, toHoldingId: v ?? "" })}
                          items={buildHoldingItems(destHoldings)}
                          placeholder="Pick a holding"
                          searchPlaceholder="Search holdings…"
                          emptyMessage="No matches"
                          size="sm"
                          className="w-full"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">
                          Quantity (shares) <span className="text-rose-600">*</span>
                        </Label>
                        <Input
                          type="number"
                          step="0.0001"
                          min="0"
                          value={transferForm.quantity}
                          onChange={(e) => setTransferForm({ ...transferForm, quantity: e.target.value })}
                          placeholder="e.g. 10.0000"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {(() => {
              const fromAcct = accounts.find((a) => String(a.id) === transferForm.fromAccountId);
              const toAcct = accounts.find((a) => String(a.id) === transferForm.toAccountId);
              const isCrossCcy = !!fromAcct && !!toAcct && fromAcct.currency !== toAcct.currency;
              if (!isCrossCcy) return null;
              return (
                <div className="space-y-2 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Amount received ({toAcct!.currency})</Label>
                    {transferFxPreview.state === "loading" && (
                      <span className="text-[11px] text-muted-foreground">Calculating…</span>
                    )}
                    {transferFxPreview.state === "ok" && (
                      <span className="text-[11px] text-muted-foreground">
                        rate {transferFxPreview.rate.toFixed(6)} · {transferFxPreview.source}
                      </span>
                    )}
                  </div>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={transferForm.receivedAmount}
                    onChange={(e) => {
                      setTransferReceivedTouched(true);
                      setTransferForm({ ...transferForm, receivedAmount: e.target.value });
                    }}
                    placeholder={
                      transferFxPreview.state === "ok" ? transferFxPreview.converted.toFixed(2) : "0.00"
                    }
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Pre-filled from market FX. Override with the actual amount your bank credited.
                  </p>
                  {transferFxPreview.state === "needs-override" && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      No FX rate cached for this pair —{" "}
                      <Link href="/settings/general" className="underline">
                        add a custom rate
                      </Link>{" "}
                      or type the amount manually.
                    </p>
                  )}
                  {transferFxPreview.state === "error" && (
                    <p className="text-[11px] text-rose-600 dark:text-rose-400">{transferFxPreview.message}</p>
                  )}
                </div>
              );
            })()}

            <div className="space-y-1.5">
              <Label>Note (applied to both legs)</Label>
              <Input
                value={transferForm.note}
                onChange={(e) => setTransferForm({ ...transferForm, note: e.target.value })}
                placeholder="e.g. rent buffer"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Tags (comma-separated, applied to both legs)</Label>
              <Input
                value={transferForm.tags}
                onChange={(e) => setTransferForm({ ...transferForm, tags: e.target.value })}
              />
            </div>

            {transferEdit && (() => {
              const debit = editingTx;
              const credit = transferEditCredit;
              if (!debit && !credit) return null;
              const createdCandidates = [debit?.createdAt, credit?.createdAt]
                .filter((v): v is string => !!v)
                .map((v) => new Date(v).getTime())
                .filter((v) => !Number.isNaN(v));
              const updatedCandidates = [debit?.updatedAt, credit?.updatedAt]
                .filter((v): v is string => !!v)
                .map((v) => new Date(v).getTime())
                .filter((v) => !Number.isNaN(v));
              const created = createdCandidates.length
                ? new Date(Math.min(...createdCandidates)).toLocaleString()
                : null;
              const updated = updatedCandidates.length
                ? new Date(Math.max(...updatedCandidates)).toLocaleString()
                : null;
              const src = debit?.source ?? credit?.source ?? null;
              const sourceLabel = src ? labelForSource(src) : null;
              if (!created && !updated && !sourceLabel) return null;
              return (
                <div className="text-[11px] text-muted-foreground border-t pt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {created && <span>Created {created}</span>}
                  {updated && <span>· Updated {updated}</span>}
                  {sourceLabel && (
                    <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                      {sourceLabel}
                    </Badge>
                  )}
                </div>
              );
            })()}

            {submitError && (
              <div className="rounded-md border border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                {submitError.message}{" "}
                {submitError.currency && (
                  <Link href="/settings/general" className="underline hover:no-underline">
                    Add a custom rate
                  </Link>
                )}
              </div>
            )}

            <div className="flex gap-2">
              {transferEdit && (
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive border-destructive/30"
                  disabled={transferDeleting}
                  onClick={handleTransferDelete}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  {transferDeleting ? "Deleting…" : "Delete transfer (both legs)"}
                </Button>
              )}
              <Button type="submit" className="flex-1">
                {transferEdit ? "Update Transfer" : "Create Transfer"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
