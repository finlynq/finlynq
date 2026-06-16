"use client";

/**
 * /settings/investments — the consolidated Investments surface (3 tabs).
 *
 * Tab "Securities"   — the catalog: one row per security (Symbol / Description /
 *   Type / Currency), filterable by column header. "Add security" DEFINES a bare
 *   security from a ticker (auto-filling name + currency from the quote lookup
 *   when possible) with NO account — it's a catalog entry until linked. Rename;
 *   Delete is offered only for securities not held in any account.
 * Tab "By security" — collapsible securities → the accounts that hold them, with
 *   "+ Account" to link another account (creates an empty position).
 * Tab "By account"  — the reverse: collapsible investment accounts → the
 *   securities they hold, with "+ Security" to add one.
 *
 * Linking (Tab 2/3) reuses POST /api/securities {securityId, accountId};
 * unlinking a tx-free position uses DELETE /api/securities?positionId. Bare
 * create/delete use /api/securities/define; ticker auto-fill uses
 * /api/securities/lookup. Absorbs the former /settings/holding-accounts +
 * /settings/securities pages (both redirect here). Bespoke fetch/useState (NO
 * SWR). → plan/architecture/securities.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RebuildSnapshotsButton } from "@/components/portfolio/rebuild-snapshots-button";
import { PageSkeleton } from "@/components/page-skeleton";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { parseSaveError } from "@/lib/save-error";
import {
  Briefcase,
  Plus,
  Pencil,
  Trash2,
  History,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";

type SecurityAccount = {
  accountId: number;
  accountName: string | null;
  isInvestment: boolean;
  positionId: number;
  isCash: boolean;
};

type Security = {
  id: number;
  symbol: string | null;
  name: string | null;
  assetType: string;
  currency: string;
  isCash: boolean;
  isCrypto: boolean;
  image: string | null;
  accounts: SecurityAccount[];
};

type Account = {
  id: number;
  name: string;
  type: string;
  currency: string;
  isInvestment: boolean;
  archived?: boolean;
};

function symbolLabel(s: Security): string {
  return s.symbol?.trim() || s.name?.trim() || "—";
}

/** The human display name, only when it's distinct from the ticker code. */
function descriptionOf(s: Security): string {
  const sym = symbolLabel(s);
  const nm = s.name?.trim() ?? "";
  return nm && nm.toUpperCase() !== sym.toUpperCase() ? nm : "";
}

type SortKey = "symbol" | "description" | "type" | "currency";
type SortDir = "asc" | "desc";
type FilterKey = "symbol" | "description" | "type" | "currency";

const EMPTY_FILTERS: Record<FilterKey, string> = {
  symbol: "",
  description: "",
  type: "",
  currency: "",
};

type LinkDialogState =
  | { mode: "account"; securityId: number } // pick an account for this security
  | { mode: "security"; accountId: number } // pick a security for this account
  | null;

export default function InvestmentsSettingsPage() {
  const [securities, setSecurities] = useState<Security[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  // Tab 1 table controls.
  const [filters, setFilters] = useState<Record<FilterKey, string>>(EMPTY_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "symbol", dir: "asc" });

  // Add-security dialog (bare catalog entry — no account).
  const [addOpen, setAddOpen] = useState(false);
  const [addSymbol, setAddSymbol] = useState("");
  const [addName, setAddName] = useState("");
  const [addCurrency, setAddCurrency] = useState("USD");
  const [addIsCrypto, setAddIsCrypto] = useState(false);
  const [addErrors, setAddErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  // Auto-fill bookkeeping (refs avoid stale-closure reads inside the async
  // lookup): which fields the user edited by hand + a sequence guard so a slow
  // lookup for a previous ticker can't clobber a newer one.
  const nameTouchedRef = useRef(false);
  const currencyTouchedRef = useRef(false);
  const cryptoTouchedRef = useRef(false);
  const lookupSeqRef = useRef(0);

  // Add-cash-sleeve dialog (Tab 3 "+ Cash").
  const [cashAccountId, setCashAccountId] = useState<number | null>(null);
  const [cashCurrency, setCashCurrency] = useState("");
  const [cashError, setCashError] = useState("");
  const [cashSubmitting, setCashSubmitting] = useState(false);

  // Rename dialog.
  const [renameSecurity, setRenameSecurity] = useState<Security | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState(false);

  // Delete confirm (catalog cleanup, unused securities only).
  const [deleteTarget, setDeleteTarget] = useState<Security | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Link dialog (Tab 2 "+ Account" / Tab 3 "+ Security").
  const [linkDialog, setLinkDialog] = useState<LinkDialogState>(null);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linking, setLinking] = useState(false);

  // Collapsible expand sets.
  const [expandedSecurities, setExpandedSecurities] = useState<Set<number>>(new Set());
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, aRes] = await Promise.all([
        fetch("/api/securities"),
        fetch("/api/accounts"),
      ]);
      if (!sRes.ok) throw new Error("Failed to load securities");
      const json: { data: Security[] } = await sRes.json();
      setSecurities(json.data ?? []);
      setAccounts(aRes.ok ? ((await aRes.json()) as Account[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  }

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  // ---- value→label maps (base-ui Select shows the raw value otherwise) ----
  const securityLabelById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of securities ?? []) {
      const d = descriptionOf(s);
      m[String(s.id)] = `${symbolLabel(s)}${d ? ` — ${d}` : ""} (${s.currency})`;
    }
    return m;
  }, [securities]);
  const accountLabelById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of accounts) m[String(a.id)] = `${a.name} (${a.currency})`;
    return m;
  }, [accounts]);

  // ---- Tab 1 rows ----
  const rows = useMemo(() => {
    if (!securities) return [];
    const mapped = securities.map((s) => ({
      s,
      symbol: symbolLabel(s),
      description: descriptionOf(s),
      type: s.assetType,
      currency: s.currency,
    }));
    const filtered = mapped.filter(
      (r) =>
        (!filters.symbol || r.symbol.toLowerCase().includes(filters.symbol.toLowerCase())) &&
        (!filters.description ||
          r.description.toLowerCase().includes(filters.description.toLowerCase())) &&
        (!filters.type || r.type.toLowerCase().includes(filters.type.toLowerCase())) &&
        (!filters.currency ||
          r.currency.toLowerCase().includes(filters.currency.toLowerCase())),
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      const av = String(a[sort.key] ?? "").toLowerCase();
      const bv = String(b[sort.key] ?? "").toLowerCase();
      return av.localeCompare(bv) * dir;
    });
    return filtered;
  }, [securities, filters, sort]);

  const hasActiveFilter = Object.values(filters).some((v) => v.trim() !== "");

  // ---- Tab 3 inversion: investment accounts → their securities ----
  const byAccount = useMemo(() => {
    const map = new Map<
      number,
      { account: Account; items: { security: Security; positionId: number; isCash: boolean }[] }
    >();
    for (const a of accounts) {
      if (a.isInvestment && !a.archived) map.set(a.id, { account: a, items: [] });
    }
    for (const s of securities ?? []) {
      for (const a of s.accounts) {
        let entry = map.get(a.accountId);
        if (!entry) {
          const acct = accounts.find((x) => x.id === a.accountId);
          if (!acct) continue;
          entry = { account: acct, items: [] };
          map.set(a.accountId, entry);
        }
        entry.items.push({ security: s, positionId: a.positionId, isCash: a.isCash });
      }
    }
    return Array.from(map.values()).sort((x, y) => x.account.name.localeCompare(y.account.name));
  }, [securities, accounts]);

  // ---- Add security (bare catalog entry) ----
  function openAdd() {
    setAddSymbol("");
    setAddName("");
    setAddCurrency("USD");
    setAddIsCrypto(false);
    nameTouchedRef.current = false;
    currencyTouchedRef.current = false;
    cryptoTouchedRef.current = false;
    lookupSeqRef.current++; // invalidate any in-flight lookup
    setAddErrors({});
    setAddOpen(true);
  }

  // Resolve name/currency (+ crypto detection) for a ticker. Refreshes the
  // auto-managed fields to match THIS ticker — clearing a stale auto-name when
  // the new ticker is unknown — but never overwrites a field the user edited.
  async function lookupTicker(rawSymbol: string, crypto: boolean) {
    const symbol = rawSymbol.trim();
    const seq = ++lookupSeqRef.current;
    if (!symbol) {
      if (!nameTouchedRef.current) setAddName("");
      return;
    }
    setLookupLoading(true);
    try {
      // Only FORCE the crypto path when the user MANUALLY ticked the box — an
      // auto-detected crypto flag left over from a previous ticker must not
      // force-classify the next one (else BTC→AAPL stays "crypto" + no name).
      const forceCrypto = cryptoTouchedRef.current && crypto;
      const res = await fetch(
        `/api/securities/lookup?symbol=${encodeURIComponent(symbol)}${forceCrypto ? "&crypto=1" : ""}`,
      );
      let name: string | null = null;
      let currency: string | null = null;
      let isCrypto: boolean | undefined;
      if (res.ok) {
        const json = await res.json();
        const d = (json.data ?? json) as {
          found?: boolean;
          name?: string | null;
          currency?: string | null;
          isCrypto?: boolean;
        };
        name = d?.name ?? null;
        currency = d?.currency ?? null;
        isCrypto = d?.isCrypto;
      }
      if (seq !== lookupSeqRef.current) return; // superseded by a newer lookup
      if (!nameTouchedRef.current) setAddName(name ?? "");
      if (!currencyTouchedRef.current && currency) setAddCurrency(currency);
      if (!cryptoTouchedRef.current && typeof isCrypto === "boolean") setAddIsCrypto(isCrypto);
    } catch {
      /* best-effort — manual entry */
    } finally {
      if (seq === lookupSeqRef.current) setLookupLoading(false);
    }
  }

  function openCash(accountId: number) {
    setCashAccountId(accountId);
    setCashCurrency("");
    setCashError("");
  }

  async function submitCash() {
    if (cashAccountId == null) return;
    const currency = cashCurrency.trim().toUpperCase();
    if (!/^[A-Z]{3,4}$/.test(currency)) {
      setCashError("Enter a 3-4 letter currency code");
      return;
    }
    setCashSubmitting(true);
    try {
      const res = await fetch("/api/portfolio/holdings/cash-sleeve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: cashAccountId, currency }),
      });
      if (!res.ok) {
        const msg = await parseSaveError(res, "Failed to add cash sleeve");
        setCashError(msg);
        return;
      }
      setCashAccountId(null);
      showToast("success", "Cash sleeve added");
      await load();
    } catch (e) {
      setCashError(e instanceof Error ? e.message : "Failed");
    } finally {
      setCashSubmitting(false);
    }
  }

  async function submitAddSecurity() {
    const symbol = addSymbol.trim();
    const currency = addCurrency.trim().toUpperCase();
    const errs: Record<string, string> = {};
    if (!symbol) errs.symbol = "Ticker is required";
    if (!/^[A-Z]{3,4}$/.test(currency)) errs.currency = "Enter a 3-4 letter currency code";
    setAddErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setAdding(true);
    try {
      const res = await fetch("/api/securities/define", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          name: addName.trim() || undefined,
          currency,
          isCrypto: addIsCrypto,
        }),
      });
      if (!res.ok) {
        const msg = await parseSaveError(res, "Failed to add security");
        setAddErrors({ symbol: msg });
        return;
      }
      setAddOpen(false);
      showToast("success", "Security added");
      await load();
    } catch (e) {
      setAddErrors({ symbol: e instanceof Error ? e.message : "Failed" });
    } finally {
      setAdding(false);
    }
  }

  // ---- Rename ----
  function openRename(s: Security) {
    setRenameSecurity(s);
    setRenameValue(s.name ?? "");
    setRenameErrors({});
  }

  async function submitRename() {
    if (!renameSecurity) return;
    const name = renameValue.trim();
    if (!name) {
      setRenameErrors({ name: "Name is required" });
      return;
    }
    setRenameErrors({});
    setRenaming(true);
    try {
      const res = await fetch("/api/securities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: renameSecurity.id, name }),
      });
      if (!res.ok) {
        const msg = await parseSaveError(res, "Failed to rename security");
        setRenameErrors({ name: msg });
        return;
      }
      setRenameSecurity(null);
      showToast("success", "Security renamed");
      await load();
    } catch (e) {
      setRenameErrors({ name: e instanceof Error ? e.message : "Rename failed" });
    } finally {
      setRenaming(false);
    }
  }

  // ---- Delete (unused securities only) ----
  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/securities/define?id=${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const msg = await parseSaveError(res, "Failed to delete security");
        showToast("error", msg);
        return;
      }
      showToast("success", "Security deleted");
      setDeleteTarget(null);
      await load();
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  // ---- Link / unlink (Tab 2 + Tab 3) ----
  function openLinkAccount(securityId: number) {
    setLinkDialog({ mode: "account", securityId });
    setLinkValue("");
    setLinkError("");
  }
  function openLinkSecurity(accountId: number) {
    setLinkDialog({ mode: "security", accountId });
    setLinkValue("");
    setLinkError("");
  }

  const linkEligible = useMemo(() => {
    if (!linkDialog) return [] as { value: string; label: string }[];
    if (linkDialog.mode === "account") {
      const sec = securities?.find((s) => s.id === linkDialog.securityId);
      const taken = new Set(sec?.accounts.map((a) => a.accountId) ?? []);
      return accounts
        .filter((a) => a.isInvestment && !a.archived && !taken.has(a.id))
        .map((a) => ({ value: String(a.id), label: `${a.name} (${a.currency})` }));
    }
    const heldHere = new Set(
      (securities ?? [])
        .filter((s) => s.accounts.some((a) => a.accountId === linkDialog.accountId))
        .map((s) => s.id),
    );
    return (securities ?? [])
      .filter((s) => !heldHere.has(s.id))
      .map((s) => {
        const d = descriptionOf(s);
        return { value: String(s.id), label: `${symbolLabel(s)}${d ? ` — ${d}` : ""} (${s.currency})` };
      });
  }, [linkDialog, securities, accounts]);

  const linkItems = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of linkEligible) m[e.value] = e.label;
    return m;
  }, [linkEligible]);

  async function submitLink() {
    if (!linkDialog) return;
    const picked = parseInt(linkValue, 10);
    if (!Number.isFinite(picked) || picked <= 0) {
      setLinkError(linkDialog.mode === "account" ? "Pick an account" : "Pick a security");
      return;
    }
    const securityId = linkDialog.mode === "account" ? linkDialog.securityId : picked;
    const accountId = linkDialog.mode === "account" ? picked : linkDialog.accountId;
    setLinking(true);
    try {
      const res = await fetch("/api/securities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ securityId, accountId }),
      });
      if (!res.ok) {
        const msg = await parseSaveError(res, "Failed to link");
        setLinkError(msg);
        return;
      }
      setLinkDialog(null);
      showToast("success", "Linked");
      await load();
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLinking(false);
    }
  }

  async function unlinkPosition(positionId: number) {
    try {
      const res = await fetch(`/api/securities?positionId=${positionId}`, { method: "DELETE" });
      if (!res.ok) {
        const msg = await parseSaveError(res, "Failed to unlink");
        showToast("error", msg);
        return;
      }
      showToast("success", "Unlinked");
      await load();
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "Unlink failed");
    }
  }

  function toggleSecurity(id: number) {
    setExpandedSecurities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAccount(id: number) {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ---- Render ----
  if (loading && !securities) {
    return (
      <div className="max-w-5xl">
        <PageSkeleton variant="cards" rows={4} />
      </div>
    );
  }
  if (error && !securities) {
    return (
      <div className="max-w-5xl">
        <ErrorState title="Couldn't load investments" message={error} onRetry={load} />
      </div>
    );
  }

  const sortHeader = (k: SortKey, label: string) => {
    const active = sort.key === k;
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 font-medium hover:text-foreground"
      >
        {label}
        {active ? (
          sort.dir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    );
  };

  const filterInput = (col: FilterKey) => (
    <Input
      value={filters[col]}
      onChange={(e) => setFilters((p) => ({ ...p, [col]: e.target.value }))}
      placeholder="Filter…"
      className="h-7 text-xs"
      aria-label={`Filter by ${col}`}
    />
  );

  const allSecurities = securities ?? [];

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Investments</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your securities, and how they map to your accounts.
          </p>
        </div>
      </div>

      {toast && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            toast.type === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900"
              : "border-rose-300 bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
          }`}
        >
          {toast.msg}
        </div>
      )}

      <Tabs defaultValue="securities" className="w-full">
        <TabsList>
          <TabsTrigger value="securities">Securities</TabsTrigger>
          <TabsTrigger value="by-security">By security</TabsTrigger>
          <TabsTrigger value="by-account">By account</TabsTrigger>
        </TabsList>

        {/* ── Tab 1: Securities catalog ─────────────────────────────────── */}
        <TabsContent value="securities" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Every security you hold or track appears once. Filter by any column.
            </p>
            <Button onClick={openAdd} size="sm">
              <Plus className="h-4 w-4 mr-1.5" /> Add security
            </Button>
          </div>

          {allSecurities.length === 0 ? (
            <EmptyState
              icon={Briefcase}
              title="No securities yet"
              description="Add a security (a ticker, cash, or crypto), then link it to your accounts under “By security” or “By account”."
              action={{ label: "Add security", onClick: openAdd }}
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{sortHeader("symbol", "Symbol")}</TableHead>
                    <TableHead>{sortHeader("description", "Description")}</TableHead>
                    <TableHead>{sortHeader("type", "Type")}</TableHead>
                    <TableHead>{sortHeader("currency", "Currency")}</TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                  <TableRow>
                    <TableHead className="py-1">{filterInput("symbol")}</TableHead>
                    <TableHead className="py-1">{filterInput("description")}</TableHead>
                    <TableHead className="py-1">{filterInput("type")}</TableHead>
                    <TableHead className="py-1">{filterInput("currency")}</TableHead>
                    <TableHead className="py-1" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                        {hasActiveFilter ? "No securities match the current filters." : "No securities."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((r) => (
                      <TableRow key={r.s.id}>
                        <TableCell className="text-sm font-mono font-medium">
                          {r.symbol}
                          {r.s.isCash && (
                            <Badge variant="outline" className="ml-1.5 text-[10px]">
                              cash
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {r.description || <span className="text-muted-foreground">--</span>}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {r.type}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {r.currency}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex gap-1">
                            <Button variant="ghost" size="sm" onClick={() => openRename(r.s)}>
                              <Pencil className="h-3.5 w-3.5 mr-1" /> Rename
                            </Button>
                            {r.s.accounts.length === 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setDeleteTarget(r.s)}
                                title="Delete this unused security"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          {allSecurities.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {rows.length} of {allSecurities.length} securities
              {hasActiveFilter ? " (filtered)" : ""}.
            </p>
          )}
        </TabsContent>

        {/* ── Tab 2: By security → accounts ─────────────────────────────── */}
        <TabsContent value="by-security" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Expand a security to see (and change) which accounts hold it.
          </p>
          {allSecurities.length === 0 ? (
            <EmptyState
              icon={Briefcase}
              title="No securities yet"
              description="Add a security on the Securities tab first."
            />
          ) : (
            <div className="rounded-md border divide-y">
              {allSecurities.map((s) => {
                const open = expandedSecurities.has(s.id);
                return (
                  <div key={s.id}>
                    <button
                      type="button"
                      onClick={() => toggleSecurity(s.id)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {open ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="font-mono text-sm font-medium">{symbolLabel(s)}</span>
                        {descriptionOf(s) && (
                          <span className="truncate text-xs text-muted-foreground">{descriptionOf(s)}</span>
                        )}
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {s.accounts.length} {s.accounts.length === 1 ? "account" : "accounts"}
                      </Badge>
                    </button>
                    {open && (
                      <div className="px-3 pb-3 pl-9 space-y-1.5">
                        {s.accounts.length === 0 ? (
                          <p className="text-xs text-muted-foreground">Not in any account yet.</p>
                        ) : (
                          s.accounts.map((a) => (
                            <div
                              key={a.positionId}
                              className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5"
                            >
                              <span className="text-sm">
                                {a.accountName ?? "(account)"}
                                {a.isCash && (
                                  <span className="ml-1.5 text-[10px] text-muted-foreground">cash sleeve</span>
                                )}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => unlinkPosition(a.positionId)}
                                title="Unlink (transaction-free positions only)"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                              </Button>
                            </div>
                          ))
                        )}
                        <Button variant="outline" size="sm" onClick={() => openLinkAccount(s.id)}>
                          <Plus className="h-3.5 w-3.5 mr-1" /> Account
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Tab 3: By account → securities ────────────────────────────── */}
        <TabsContent value="by-account" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Expand an account to see (and change) which securities it holds.
          </p>
          {byAccount.length === 0 ? (
            <EmptyState
              icon={Briefcase}
              title="No investment accounts"
              description="Create an investment account first, then add securities to it here."
            />
          ) : (
            <div className="rounded-md border divide-y">
              {byAccount.map(({ account, items }) => {
                const open = expandedAccounts.has(account.id);
                return (
                  <div key={account.id}>
                    <button
                      type="button"
                      onClick={() => toggleAccount(account.id)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {open ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="text-sm font-medium truncate">{account.name}</span>
                        <Badge variant="outline" className="font-mono text-[10px] shrink-0">
                          {account.currency}
                        </Badge>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {items.length} {items.length === 1 ? "security" : "securities"}
                      </Badge>
                    </button>
                    {open && (
                      <div className="px-3 pb-3 pl-9 space-y-1.5">
                        {items.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No securities in this account yet.</p>
                        ) : (
                          items.map(({ security, positionId, isCash }) => (
                            <div
                              key={positionId}
                              className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5"
                            >
                              <span className="text-sm font-mono">
                                {symbolLabel(security)}
                                {isCash && (
                                  <span className="ml-1.5 font-sans text-[10px] text-muted-foreground">
                                    cash sleeve
                                  </span>
                                )}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => unlinkPosition(positionId)}
                                title="Unlink (transaction-free positions only)"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                              </Button>
                            </div>
                          ))
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" onClick={() => openLinkSecurity(account.id)}>
                            <Plus className="h-3.5 w-3.5 mr-1" /> Security
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => openCash(account.id)}>
                            <Plus className="h-3.5 w-3.5 mr-1" /> Cash
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Rebuild investment history (page-level utility). */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
              <History className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Rebuild investment history</CardTitle>
              <CardDescription>
                Recompute daily portfolio value snapshots from your first transaction
                to today. Run this if the &ldquo;Net Worth Over Time&rdquo; chart looks
                stale after a back-dated trade edit.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <RebuildSnapshotsButton />
        </CardContent>
      </Card>

      {/* ── Add security dialog (bare catalog entry) ───────────────────── */}
      <Dialog open={addOpen} onOpenChange={(o) => { if (!o) setAddOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add security</DialogTitle>
            <DialogDescription>
              Define a security by its ticker. Link it to an account later under “By
              security” / “By account”.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Ticker</Label>
              <div className="relative">
                <Input
                  value={addSymbol}
                  onChange={(e) => {
                    setAddSymbol(e.target.value);
                    if (!nameTouchedRef.current) setAddName(""); // drop stale auto-name
                  }}
                  onBlur={() => lookupTicker(addSymbol, addIsCrypto)}
                  placeholder="e.g. AAPL, VTI, BTC"
                  autoFocus
                />
                {lookupLoading && (
                  <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              {addErrors.symbol && <p className="text-xs text-rose-600 mt-1">{addErrors.symbol}</p>}
              <p className="text-[11px] text-muted-foreground mt-1">
                We’ll try to fill the name + currency from the ticker; edit them if needed.
              </p>
            </div>
            <div>
              <Label>Name</Label>
              <Input
                value={addName}
                onChange={(e) => {
                  setAddName(e.target.value);
                  nameTouchedRef.current = true;
                }}
                placeholder="auto-filled from the ticker, or type it"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Holding currency</Label>
                <Input
                  value={addCurrency}
                  onChange={(e) => {
                    setAddCurrency(e.target.value.toUpperCase());
                    currencyTouchedRef.current = true;
                  }}
                  placeholder="USD"
                  maxLength={4}
                />
                {addErrors.currency && <p className="text-xs text-rose-600 mt-1">{addErrors.currency}</p>}
              </div>
              <label className="flex items-end gap-2 text-sm cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={addIsCrypto}
                  onChange={(e) => {
                    setAddIsCrypto(e.target.checked);
                    cryptoTouchedRef.current = true;
                    lookupTicker(addSymbol, e.target.checked);
                  }}
                />
                Crypto asset
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={adding}>
              Cancel
            </Button>
            <Button onClick={submitAddSecurity} disabled={adding}>
              {adding ? "Adding…" : "Add security"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Link dialog (Tab 2 "+ Account" / Tab 3 "+ Security") ───────── */}
      <Dialog open={linkDialog != null} onOpenChange={(o) => { if (!o) setLinkDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{linkDialog?.mode === "account" ? "Add to an account" : "Add a security"}</DialogTitle>
            <DialogDescription>
              {linkDialog?.mode === "account"
                ? "Choose an account to hold this security. Quantity and cost basis come from a transaction."
                : "Choose a security to add to this account. Quantity and cost basis come from a transaction."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{linkDialog?.mode === "account" ? "Account" : "Security"}</Label>
              <Select items={linkItems} value={linkValue} onValueChange={(v) => setLinkValue(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder={linkDialog?.mode === "account" ? "Choose an account" : "Choose a security"} />
                </SelectTrigger>
                <SelectContent>
                  {linkEligible.length === 0 ? (
                    <SelectItem value="__none__" disabled>
                      {linkDialog?.mode === "account" ? "No eligible accounts" : "No eligible securities"}
                    </SelectItem>
                  ) : (
                    linkEligible.map((e) => (
                      <SelectItem key={e.value} value={e.value}>
                        {e.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {linkError && <p className="text-xs text-rose-600 mt-1">{linkError}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkDialog(null)} disabled={linking}>
              Cancel
            </Button>
            <Button onClick={submitLink} disabled={linking}>
              {linking ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add cash sleeve dialog (Tab 3 "+ Cash") ───────────────────── */}
      <Dialog open={cashAccountId != null} onOpenChange={(o) => { if (!o) setCashAccountId(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add cash sleeve</DialogTitle>
            <DialogDescription>
              Add a per-currency cash position to this account (e.g. a USD sleeve in a
              CAD account). One sleeve per currency.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Currency</Label>
              <Input
                value={cashCurrency}
                onChange={(e) => setCashCurrency(e.target.value.toUpperCase())}
                placeholder="e.g. USD, EUR, XAU"
                maxLength={4}
                autoFocus
              />
              {cashError && <p className="text-xs text-rose-600 mt-1">{cashError}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCashAccountId(null)} disabled={cashSubmitting}>
              Cancel
            </Button>
            <Button onClick={submitCash} disabled={cashSubmitting}>
              {cashSubmitting ? "Adding…" : "Add cash sleeve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Rename dialog ──────────────────────────────────────────────── */}
      <Dialog open={renameSecurity != null} onOpenChange={(o) => { if (!o) setRenameSecurity(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename security</DialogTitle>
            <DialogDescription>
              Update the display label for {renameSecurity ? symbolLabel(renameSecurity) : "this security"}.
              This renames it across every account that holds it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Display name</Label>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="e.g. Apple Inc."
              />
              {renameErrors.name && <p className="text-xs text-rose-600 mt-1">{renameErrors.name}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameSecurity(null)} disabled={renaming}>
              Cancel
            </Button>
            <Button onClick={submitRename} disabled={renaming}>
              {renaming ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm (unused securities only) ────────────────────── */}
      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title="Delete security"
        description={
          deleteTarget
            ? `Remove ${symbolLabel(deleteTarget)} from your catalog? It isn't held in any account. This can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        busyLabel="Deleting…"
        busy={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
