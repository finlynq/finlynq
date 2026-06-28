"use client";

/**
 * /settings/import — account-agnostic import MANAGEMENT.
 *
 * Phase 1 of the money-in surface consolidation (merge /import + /import/pending
 * + /reconcile + /inbox → a single account-anchored /import surface). The old
 * /import page conflated a per-account upload ACTION with account-agnostic
 * MANAGEMENT (CSV templates, the WealthPosition connector, the email-import
 * address). The management half has no home in an account-anchored flow, so it
 * moves here. The upload action stays on /import and (later phases) folds into
 * the account surface's upload drawer.
 *
 * Everything here is lifted verbatim from the old /import tabs — same
 * components (`TemplateManager`, `ConnectorTab`), same endpoints
 * (/api/import/templates, /api/import/email-config). No API changes.
 */

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Mail,
  Copy,
  RefreshCw,
  BookTemplate,
  Link as LinkIcon,
  Landmark,
  ToggleLeft,
  ToggleRight,
  FileSpreadsheet,
  EyeOff,
  ChevronRight,
} from "lucide-react";
import Link from "next/link";
import { TemplateManager } from "@/app/(app)/import/components/template-manager";
import { ConnectorTab } from "@/app/(app)/import/components/connector-tab";
import { MoneyProConnectorTab } from "@/app/(app)/import/components/moneypro-connector-tab";
import { GenericCsvConnectorTab } from "@/app/(app)/import/components/generic-csv-connector-tab";
import { InvestmentStatementImporter } from "@/app/(app)/import/components/investment-statement-importer";
import { EmailRulesManager } from "@/components/inbox/email-rules-manager";
import type { ImportTemplate } from "@/lib/import-templates";

type ImportProvider = "wealthposition" | "moneypro" | "generic-csv";

export default function ImportSettingsPage() {
  const [accountNames, setAccountNames] = useState<string[]>([]);
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  // "Migrate from another app" tab — which provider's flow is open.
  const [provider, setProvider] = useState<ImportProvider | null>(null);
  // Active tab (controlled so it's deep-linkable via ?tab=).
  const [tab, setTab] = useState("templates");

  // Email state
  const [importEmail, setImportEmail] = useState<string | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // §B (2026-06-04) — "Confirm detected column mapping before importing"
  // per-user default. Seeds NEW accounts' csv_mapping_mode; a per-account
  // override on the upload drawer (the "Don't ask again" checkbox) wins.
  const [confirmCsvMapping, setConfirmCsvMapping] = useState(true);
  const [confirmCsvLoading, setConfirmCsvLoading] = useState(false);

  // FINLYNQ-241 — count of hidden accounts, shown on the entry-point card.
  const [hiddenAccountCount, setHiddenAccountCount] = useState<number | null>(null);

  // FINLYNQ-138 — per-user imported-email retention window (days). Governs how
  // long raw forwarded emails (email_inbox) are kept before the cleanup sweep
  // hard-deletes them. Bounded {7,30,60,90}; default 60.
  const [retentionDays, setRetentionDays] = useState<number>(60);
  const [retentionOptions, setRetentionOptions] = useState<number[]>([
    7, 30, 60, 90,
  ]);
  const [retentionLoading, setRetentionLoading] = useState(false);

  // Deep-link support: /settings/import?tab=migrate[&provider=moneypro].
  // `connect` is the legacy value for the provider-migration tab — accepted as
  // an alias so old links/bookmarks keep working.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t && ["templates", "email", "migrate", "connect", "statements"].includes(t)) {
      setTab(t === "connect" ? "migrate" : t);
    }
    const p = params.get("provider");
    if (p === "wealthposition" || p === "moneypro" || p === "generic-csv") {
      setProvider(p);
      setTab("migrate");
    }
  }, []);

  // Fetch accounts, templates, and email config on mount.
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setAccountNames(data.map((a: { name: string }) => a.name));
        }
      })
      .catch(() => {});

    fetch("/api/import/templates")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setTemplates(data);
      })
      .catch(() => {});

    fetch("/api/import/email-config")
      .then((r) => r.json())
      .then((data) => setImportEmail(data.email))
      .catch(() => {});

    fetch("/api/settings/confirm-csv-mapping")
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.confirmCsvMapping === "boolean") {
          setConfirmCsvMapping(data.confirmCsvMapping);
        }
      })
      .catch(() => {});

    fetch("/api/settings/email-retention")
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.retentionDays === "number") {
          setRetentionDays(data.retentionDays);
        }
        if (Array.isArray(data.options)) setRetentionOptions(data.options);
      })
      .catch(() => {});

    // FINLYNQ-241 — load the hidden-account count for the entry-point card.
    fetch("/api/settings/reconcile-hidden-accounts")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.accountIds)) {
          setHiddenAccountCount(data.accountIds.length);
        }
      })
      .catch(() => {});
  }, []);

  const updateRetentionDays = async (next: number) => {
    const prev = retentionDays;
    // Optimistic — revert on failure.
    setRetentionDays(next);
    setRetentionLoading(true);
    try {
      const res = await fetch("/api/settings/email-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: next }),
      });
      const data = await res.json();
      if (!res.ok || typeof data.retentionDays !== "number") {
        setRetentionDays(prev);
      } else {
        setRetentionDays(data.retentionDays);
      }
    } catch {
      setRetentionDays(prev);
    } finally {
      setRetentionLoading(false);
    }
  };

  const toggleConfirmCsvMapping = async () => {
    const next = !confirmCsvMapping;
    // Optimistic — revert on failure.
    setConfirmCsvMapping(next);
    setConfirmCsvLoading(true);
    try {
      const res = await fetch("/api/settings/confirm-csv-mapping", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmCsvMapping: next }),
      });
      const data = await res.json();
      if (!res.ok || typeof data.confirmCsvMapping !== "boolean") {
        setConfirmCsvMapping(!next);
      } else {
        setConfirmCsvMapping(data.confirmCsvMapping);
      }
    } catch {
      setConfirmCsvMapping(!next);
    } finally {
      setConfirmCsvLoading(false);
    }
  };

  const generateEmail = async () => {
    setEmailLoading(true);
    try {
      const res = await fetch("/api/import/email-config", { method: "POST" });
      const data = await res.json();
      if (data.email) setImportEmail(data.email);
    } catch {
      // ignore
    } finally {
      setEmailLoading(false);
    }
  };

  const copyEmail = () => {
    if (importEmail) {
      navigator.clipboard.writeText(importEmail);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Import</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Manage CSV templates and your email-import address, or migrate your
          full history from another app. To upload a bank statement, use the{" "}
          <a href="/import" className="underline hover:text-foreground">
            Import page
          </a>
          .
        </p>
      </div>

      {/* §B (2026-06-04) — per-user default for CSV mapping confirmation. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100 text-blue-600">
              {confirmCsvMapping ? (
                <ToggleRight className="h-5 w-5" />
              ) : (
                <ToggleLeft className="h-5 w-5" />
              )}
            </div>
            <div>
              <CardTitle className="text-base">
                Confirm field mapping before importing
              </CardTitle>
              <CardDescription>
                When on, CSV uploads show the auto-detected column mapping and
                OFX/QFX uploads show a field-mapping preview (Name vs Memo) for
                your review before any rows are staged.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">
                {confirmCsvMapping
                  ? "Confirmation is ON"
                  : "Confirmation is OFF"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {confirmCsvMapping
                  ? "Accounts ask you to confirm before staging. Per-account overrides (the “Ask me first / Apply automatically” choice in the import preview) still apply."
                  : "Accounts import silently using the detected mapping. Pick “Ask me to confirm first” in an account’s import preview to turn confirmation back on for it."}
              </p>
            </div>
            <Button
              variant={confirmCsvMapping ? "default" : "outline"}
              size="sm"
              onClick={toggleConfirmCsvMapping}
              disabled={confirmCsvLoading}
            >
              {confirmCsvMapping ? (
                <ToggleRight className="h-4 w-4 mr-1.5" />
              ) : (
                <ToggleLeft className="h-4 w-4 mr-1.5" />
              )}
              {confirmCsvMapping ? "Disable" : "Enable"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* FINLYNQ-147 / FINLYNQ-241 — hide accounts from the /import reconcile
          dropdown. The full list lives on a subpage to keep this page compact. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
              <EyeOff className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Reconcile dropdown visibility</CardTitle>
              <CardDescription>
                Choose which accounts appear in the account picker on the{" "}
                <Link href="/import" className="underline hover:text-foreground">
                  Import
                </Link>{" "}
                page. Hidden accounts stay fully accessible via direct links.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Link
            href="/settings/import/reconcile-visibility"
            className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <EyeOff className="h-4 w-4 text-muted-foreground" />
            Manage account visibility
            {hiddenAccountCount !== null && hiddenAccountCount > 0 && (
              <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                {hiddenAccountCount} hidden
              </span>
            )}
            <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto" />
          </Link>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v ?? "templates")}>
        <TabsList>
          <TabsTrigger value="templates">
            <BookTemplate className="h-4 w-4 mr-1.5" />
            Templates
            {templates.length > 0 && (
              <span className="ml-1.5 text-[10px] bg-muted rounded-full px-1.5 py-0.5 font-mono">
                {templates.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="email">
            <Mail className="h-4 w-4 mr-1.5" />
            Email Import
          </TabsTrigger>
          <TabsTrigger value="migrate">
            <LinkIcon className="h-4 w-4 mr-1.5" />
            Migrate from another app
          </TabsTrigger>
          <TabsTrigger value="statements">
            <Landmark className="h-4 w-4 mr-1.5" />
            Investment statements
          </TabsTrigger>
        </TabsList>

        {/* Templates */}
        <TabsContent value="templates">
          <div className="space-y-4 mt-4" id="templates">
            <p className="text-sm text-muted-foreground">
              Templates save your CSV column mappings so future uploads from the
              same bank are automatically recognized. Upload a CSV and click{" "}
              <span className="font-medium">Save as Template</span> in the
              preview dialog to create one.
            </p>
            <TemplateManager
              templates={templates}
              accounts={accountNames}
              onDeleted={(id) =>
                setTemplates((prev) => prev.filter((t) => t.id !== id))
              }
              onUpdated={(updated) => {
                if (updated.isDefault) {
                  // Server clears isDefault on every OTHER template when this one
                  // is set true; the PUT response only returns the updated row,
                  // so refetch to keep the "default" badge in sync across rows.
                  fetch("/api/import/templates")
                    .then((r) => r.json())
                    .then((data) => {
                      if (Array.isArray(data)) setTemplates(data);
                    })
                    .catch(() => {});
                } else {
                  setTemplates((prev) =>
                    prev.map((t) => (t.id === updated.id ? updated : t)),
                  );
                }
              }}
            />
          </div>
        </TabsContent>

        {/* Email Import */}
        <TabsContent value="email">
          <div className="space-y-4 mt-4" id="email">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Mail className="h-5 w-5 text-blue-600" />
                  Import via Email
                </CardTitle>
                <CardDescription>
                  Forward bank statements and transaction files to your unique
                  import email address.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {importEmail ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-lg border bg-muted/50 px-4 py-2.5 font-mono text-sm">
                        {importEmail}
                      </div>
                      <Button variant="outline" size="sm" onClick={copyEmail}>
                        <Copy className="h-4 w-4 mr-1" />
                        {copied ? "Copied!" : "Copy"}
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={generateEmail}
                      disabled={emailLoading}
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 mr-1.5 ${emailLoading ? "animate-spin" : ""}`}
                      />
                      Regenerate Address
                    </Button>
                  </>
                ) : (
                  <Button onClick={generateEmail} disabled={emailLoading}>
                    <Mail className="h-4 w-4 mr-2" />
                    {emailLoading
                      ? "Generating..."
                      : "Generate Import Email Address"}
                  </Button>
                )}

                <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                  <p className="text-sm font-medium">How it works</p>
                  <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                    <li>
                      Forward your bank statement email (or attach a CSV file) to
                      the address above.
                    </li>
                    <li>
                      CSV attachments are matched against your saved import
                      templates automatically.
                    </li>
                    <li>
                      A transaction in the email <span className="font-medium">body</span>{" "}
                      (a bank &quot;you spent $X&quot; alert) is parsed too and
                      shows up in the{" "}
                      <a href="/import?tab=email" className="underline hover:no-underline">
                        Email tab
                      </a>{" "}
                      of Import.
                    </li>
                    <li>
                      Set up an <span className="font-medium">email rule</span>{" "}
                      below to auto-record body emails from a known sender.
                    </li>
                    <li>
                      Duplicate transactions are flagged and skipped on approve.
                    </li>
                    <li>
                      Pending parsed imports auto-expire after 14 days. The raw
                      forwarded emails are kept for your{" "}
                      <span className="font-medium">retention window</span>{" "}
                      (below), then permanently deleted.
                    </li>
                  </ol>
                </div>
              </CardContent>
            </Card>

            {/* FINLYNQ-138 — imported-email retention window. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Imported-email retention
                </CardTitle>
                <CardDescription>
                  How long Finlynq keeps the raw emails you forward to your
                  import address before permanently deleting them. The cleanup
                  sweep applies this to all existing imported emails the next
                  time it runs.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">Keep raw emails for</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Parsed transactions you&apos;ve recorded are unaffected —
                      only the original email content is deleted.
                    </p>
                  </div>
                  <Select
                    value={String(retentionDays)}
                    onValueChange={(v) =>
                      v && void updateRetentionDays(parseInt(v, 10))
                    }
                    disabled={retentionLoading}
                  >
                    <SelectTrigger className="w-[140px] h-9">
                      <SelectValue>{retentionDays} days</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {retentionOptions.map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d} days
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <EmailRulesManager />
          </div>
        </TabsContent>

        {/* Migrate from another app — per-source submenu */}
        <TabsContent value="migrate">
          <div className="mt-4 space-y-4" id="migrate">
            {provider === null ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Migrate your full history from another personal-finance app.
                  This is a one-time bulk move of your whole ledger — to import a
                  bank statement instead, use the{" "}
                  <a href="/import" className="underline hover:text-foreground">
                    Import page
                  </a>
                  . Pick an app to start.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setProvider("wealthposition")}
                    className="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/40"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
                      <LinkIcon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">WealthPosition</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Import a WealthPosition export ZIP, with optional balance
                        reconciliation.
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setProvider("moneypro")}
                    className="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/40"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                      <FileSpreadsheet className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">Money Pro</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Import a Money Pro Transactions report exported as CSV.
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setProvider("generic-csv")}
                    className="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/40"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-100 text-sky-600">
                      <FileSpreadsheet className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">Generic CSV (full ledger)</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Import any multi-account CSV (date, amount, account, plus
                        optional currency, category and transfers).
                      </div>
                    </div>
                  </button>
                </div>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setProvider(null)}
                >
                  ← Back to providers
                </Button>
                {provider === "wealthposition" ? (
                  <ConnectorTab />
                ) : provider === "moneypro" ? (
                  <MoneyProConnectorTab />
                ) : (
                  <GenericCsvConnectorTab />
                )}
              </>
            )}
          </div>
        </TabsContent>

        {/* Investment statements (IBKR XML / multi-account OFX/QFX) */}
        <TabsContent value="statements">
          <div className="mt-4" id="statements">
            <InvestmentStatementImporter />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
