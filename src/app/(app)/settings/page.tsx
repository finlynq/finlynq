"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { Download, Database, Server, Shield, Wallet, Tag, ArrowLeftRight, Briefcase, Trash2, Pencil, Plus, AlertTriangle, Settings2, Check, X, Zap, ToggleLeft, ToggleRight, Play, Lock, Eye, EyeOff, FolderOpen, HardDrive, Cloud, RefreshCw, BarChart3, Upload, FileText, Key } from "lucide-react";
import { useDisplayCurrency } from "@/components/currency-provider";
import { SUPPORTED_FIAT_CURRENCIES, currencyLabel } from "@/lib/fx/supported-currencies";
import { FxOverridesSection } from "@/components/fx-overrides-section";
import { ActiveCurrenciesSection } from "@/components/active-currencies-section";

type Category = { id: number; type: string; group: string; name: string; note: string };

type Rule = {
  id: number;
  name: string;
  matchField: string;
  matchType: string;
  matchValue: string;
  assignCategoryId: number | null;
  categoryName: string | null;
  assignTags: string | null;
  renameTo: string | null;
  isActive: number;
  priority: number;
  createdAt: string;
};

const exportItems = [
  { type: "accounts", label: "Accounts", icon: Wallet, iconColor: "text-violet-500" },
  { type: "categories", label: "Categories", icon: Tag, iconColor: "text-emerald-500" },
  { type: "transactions", label: "Transactions", icon: ArrowLeftRight, iconColor: "text-amber-500" },
  { type: "portfolio", label: "Portfolio", icon: Briefcase, iconColor: "text-cyan-500" },
];

export default function SettingsPage() {
  const [exportStatus, setExportStatus] = useState("");
  const { displayCurrency, setDisplayCurrency } = useDisplayCurrency();
  const [currencyError, setCurrencyError] = useState("");
  const [clearConfirm, setClearConfirm] = useState("");
  const [clearStep, setClearStep] = useState(0); // 0=idle, 1=first confirm, 2=type DELETE
  const [clearStatus, setClearStatus] = useState("");

  // Backup / restore
  const [backupStatus, setBackupStatus] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePreview, setRestorePreview] = useState<Record<string, number> | null>(null);
  const [restoreBackup, setRestoreBackup] = useState<unknown>(null);
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [restoreStep, setRestoreStep] = useState(0); // 0=idle, 1=preview, 2=type RESTORE
  const [restoreStatus, setRestoreStatus] = useState("");

  // Category management
  const [categories, setCategories] = useState<Category[]>([]);
  const sortCategory = useDropdownOrder("category");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [catError, setCatError] = useState("");
  const [newCatForm, setNewCatForm] = useState({ name: "", type: "E", group: "" });
  const [newCatErrors, setNewCatErrors] = useState<{ name?: string; group?: string }>({});
  const [showAddCat, setShowAddCat] = useState(false);

  // Transaction rules
  const [rules, setRules] = useState<Rule[]>([]);
  const [showAddRule, setShowAddRule] = useState(false);
  const [ruleError, setRuleError] = useState("");
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [ruleForm, setRuleForm] = useState({
    name: "", matchField: "payee", matchType: "contains", matchValue: "",
    assignCategoryId: "", assignTags: "", renameTo: "", priority: "0",
  });
  const [ruleFormErrors, setRuleFormErrors] = useState<Record<string, string>>({});
  const [testPayee, setTestPayee] = useState("");
  const [testResult, setTestResult] = useState("");

  // Dev mode
  const [devMode, setDevMode] = useState(false);
  const [devModeLoading, setDevModeLoading] = useState(false);
  const [devModeStatus, setDevModeStatus] = useState("");

  // API Key — the raw key is only held in memory on first creation or
  // after a regenerate. On subsequent page loads, `apiKey` stays null
  // because only a hash is stored server-side; the UI shows a "regenerate
  // to view" state in that case.
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyLoaded, setApiKeyLoaded] = useState(false);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [apiKeyRegenerating, setApiKeyRegenerating] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState("");

  // CSV Import (accounts, categories, portfolio)
  type ImportSection = "accounts" | "categories" | "portfolio";
  type ImportRow = Record<string, string>;
  const [importSection, setImportSection] = useState<ImportSection | null>(null);
  const [importPreview, setImportPreview] = useState<ImportRow[]>([]);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [importLoading, setImportLoading] = useState(false);

  // Load dev mode
  useEffect(() => {
    fetch("/api/settings/dev-mode")
      .then((r) => r.json())
      .then((data) => { if (typeof data.devMode === "boolean") setDevMode(data.devMode); })
      .catch(() => {});
  }, []);

  // Load API key
  useEffect(() => {
    fetch("/api/settings/api-key")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.apiKey) setApiKey(data.apiKey); })
      .catch(() => {})
      .finally(() => setApiKeyLoaded(true));
  }, []);

  async function handleRegenerateApiKey() {
    setApiKeyRegenerating(true);
    setApiKeyStatus("");
    try {
      const res = await fetch("/api/settings/api-key", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setApiKey(data.apiKey);
        setApiKeyVisible(true);
        setApiKeyStatus("New key generated");
      } else {
        setApiKeyStatus(data.error || "Failed to regenerate");
      }
    } catch {
      setApiKeyStatus("Failed to regenerate key");
    }
    setApiKeyRegenerating(false);
  }

  function handleCopyApiKey() {
    if (!apiKey) return;
    navigator.clipboard.writeText(apiKey);
    setApiKeyCopied(true);
    setTimeout(() => setApiKeyCopied(false), 2000);
  }

  async function handleDevModeToggle() {
    setDevModeLoading(true);
    setDevModeStatus("");
    const next = !devMode;
    try {
      const res = await fetch("/api/settings/dev-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devMode: next }),
      });
      const data = await res.json();
      if (res.ok) {
        setDevMode(data.devMode);
        setDevModeStatus(data.devMode ? "Dev mode enabled" : "Dev mode disabled");
      } else {
        setDevModeStatus(data.error || "Failed to update");
      }
    } catch {
      setDevModeStatus("Failed to update dev mode");
    }
    setDevModeLoading(false);
  }

  // CSV Import helpers
  const [importAllRows, setImportAllRows] = useState<ImportRow[]>([]);

  function parseCSV(text: string): { headers: string[]; rows: ImportRow[] } {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { headers: [], rows: [] };
    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const rows: ImportRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
      const row: ImportRow = {};
      headers.forEach((h, j) => { row[h] = vals[j] ?? ""; });
      rows.push(row);
    }
    return { headers, rows };
  }

  function handleImportFile(section: ImportSection, file: File) {
    setImportSection(section);
    setImportStatus("");
    setImportPreview([]);
    setImportAllRows([]);
    setImportFileName(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers, rows } = parseCSV(text);
      if (rows.length === 0) { setImportStatus("File appears empty or has no data rows."); return; }
      setImportHeaders(headers);
      setImportPreview(rows.slice(0, 5));
      setImportAllRows(rows);
    };
    reader.readAsText(file);
  }

  async function handleImportConfirm() {
    if (!importSection || importAllRows.length === 0) return;
    setImportLoading(true);
    setImportStatus(`Importing ${importAllRows.length} rows…`);
    let ok = 0;
    let failed = 0;
    try {
      // For transactions: group rows by split_parent_id to handle split imports
      if (importSection === "accounts") {
        for (const row of importAllRows) {
          try {
            await fetch("/api/accounts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: row.name || row.Name || "",
                type: row.type || row.Type || "A",
                group: row.group || row.Group || "Other",
                currency: row.currency || row.Currency || "CAD",
                note: row.note || row.Note || "",
              }),
            });
            ok++;
          } catch { failed++; }
        }
      } else if (importSection === "categories") {
        for (const row of importAllRows) {
          try {
            await fetch("/api/categories", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: row.name || row.Name || "",
                type: row.type || row.Type || "E",
                group: row.group || row.Group || "Other",
                note: row.note || row.Note || "",
              }),
            });
            ok++;
          } catch { failed++; }
        }
      } else if (importSection === "portfolio") {
        for (const row of importAllRows) {
          try {
            await fetch("/api/portfolio", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                symbol: row.symbol || row.Symbol || row.ticker || "",
                name: row.name || row.Name || "",
                quantity: parseFloat(row.quantity || row.Quantity || "0") || 0,
                currency: row.currency || row.Currency || "CAD",
                note: row.note || row.Note || "",
              }),
            });
            ok++;
          } catch { failed++; }
        }
      }

      setImportStatus(`Imported ${ok} rows${failed > 0 ? `, ${failed} failed` : ""}.`);
      setImportPreview([]);
      setImportAllRows([]);
      setImportSection(null);
      setImportFileName("");
    } catch {
      setImportStatus("Import failed");
    } finally {
      setImportLoading(false);
    }
  }

  function handleImportFileInput(section: ImportSection) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleImportFile(section, file);
      e.target.value = "";
    };
  }

  async function handleCurrencyChange(val: string | null) {
    const v = (val ?? "CAD").toUpperCase();
    setCurrencyError("");
    try {
      await setDisplayCurrency(v);
      // Migrate any leftover localStorage value from the pre-2026-04-27 client
      // so two tabs don't disagree until the next reload.
      try { localStorage.removeItem("pf-currency"); } catch {}
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save display currency";
      setCurrencyError(msg);
    }
  }

  // Load categories
  const loadCategories = useCallback(() => {
    fetch("/api/categories").then((r) => r.json()).then(setCategories);
  }, []);

  useEffect(() => { loadCategories(); }, [loadCategories]);

  // Load rules
  const loadRules = useCallback(() => {
    fetch("/api/rules").then((r) => r.json()).then(setRules);
  }, []);

  useEffect(() => { loadRules(); }, [loadRules]);

  function resetRuleForm() {
    setRuleForm({ name: "", matchField: "payee", matchType: "contains", matchValue: "", assignCategoryId: "", assignTags: "", renameTo: "", priority: "0" });
    setRuleFormErrors({});
    setEditingRuleId(null);
  }

  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!ruleForm.name.trim()) errs.name = "Name is required";
    if (!ruleForm.matchValue.trim()) errs.matchValue = "Match value is required";
    setRuleFormErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setRuleError("");
    const payload = {
      ...(editingRuleId ? { id: editingRuleId } : {}),
      name: ruleForm.name.trim(),
      matchField: ruleForm.matchField,
      matchType: ruleForm.matchType,
      matchValue: ruleForm.matchValue.trim(),
      assignCategoryId: ruleForm.assignCategoryId ? parseInt(ruleForm.assignCategoryId) : null,
      assignTags: ruleForm.assignTags || null,
      renameTo: ruleForm.renameTo || null,
      priority: parseInt(ruleForm.priority) || 0,
    };

    try {
      const res = await fetch("/api/rules", {
        method: editingRuleId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        setRuleError(data.error || "Failed to save rule");
        return;
      }
      resetRuleForm();
      setShowAddRule(false);
      loadRules();
    } catch {
      setRuleError("Failed to save rule");
    }
  }

  async function handleDeleteRule(id: number) {
    setRuleError("");
    try {
      await fetch(`/api/rules?id=${id}`, { method: "DELETE" });
      loadRules();
    } catch {
      setRuleError("Failed to delete rule");
    }
  }

  async function handleToggleRule(rule: Rule) {
    try {
      await fetch("/api/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, isActive: rule.isActive ? 0 : 1 }),
      });
      loadRules();
    } catch {
      setRuleError("Failed to toggle rule");
    }
  }

  function handleEditRule(rule: Rule) {
    setEditingRuleId(rule.id);
    setRuleForm({
      name: rule.name,
      matchField: rule.matchField,
      matchType: rule.matchType,
      matchValue: rule.matchValue,
      assignCategoryId: rule.assignCategoryId?.toString() ?? "",
      assignTags: rule.assignTags ?? "",
      renameTo: rule.renameTo ?? "",
      priority: rule.priority.toString(),
    });
    setShowAddRule(true);
    setRuleFormErrors({});
  }

  async function handleTestRule() {
    if (!testPayee.trim()) { setTestResult("Enter a payee to test"); return; }
    setTestResult("Testing...");
    try {
      const res = await fetch("/api/transactions/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payee: testPayee.trim() }),
      });
      const data = await res.json();
      if (data.suggestion) {
        setTestResult(`Suggested: ${data.suggestion.name} (${data.suggestion.group})`);
      } else {
        setTestResult("No suggestion found for this payee");
      }
    } catch {
      setTestResult("Test failed");
    }
  }

  // Match type options based on field
  const matchTypeOptions = ruleForm.matchField === "amount"
    ? [{ value: "greater_than", label: "Greater than" }, { value: "less_than", label: "Less than" }, { value: "exact", label: "Exact" }]
    : [{ value: "contains", label: "Contains" }, { value: "exact", label: "Exact match" }, { value: "regex", label: "Regex" }];

  function csvCell(val: unknown): string {
    const s = String(val ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function buildCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    return [headers.join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\n");
  }

  async function handleExport(type: string) {
    setExportStatus(`Exporting ${type}...`);
    try {
      const res = await fetch(type === "transactions" ? `/api/${type}?limit=99999` : `/api/${type}`);
      const data = await res.json();
      let rows: Record<string, unknown>[] = Array.isArray(data) ? data : data.data ?? [];

      if (rows.length === 0) {
        setExportStatus("No data to export");
        return;
      }

      // For transactions: expand split transactions into individual split rows
      if (type === "transactions") {
        const splitsRes = await fetch("/api/transactions/splits");
        const allSplits: Array<{ transactionId: number; categoryId: number | null; accountId: number | null; amount: number; note: string; description: string; tags: string }> = splitsRes.ok ? await splitsRes.json() : [];
        const splitMap = new Map<number, typeof allSplits>();
        for (const s of allSplits) {
          const arr = splitMap.get(s.transactionId) ?? [];
          arr.push(s);
          splitMap.set(s.transactionId, arr);
        }

        const expanded: Record<string, unknown>[] = [];
        for (const txn of rows) {
          const txnId = txn.id as number;
          const splits = splitMap.get(txnId);
          if (splits && splits.length > 0) {
            // Emit one row per split; omit the parent's category, use split fields instead
            for (const s of splits) {
              expanded.push({
                ...txn,
                split_parent_id: txnId,
                categoryId: s.categoryId ?? "",
                amount: s.amount,
                note: s.note || txn.note,
                split_account_id: s.accountId ?? "",
                split_description: s.description,
                split_tags: s.tags,
              });
            }
          } else {
            expanded.push({ ...txn, split_parent_id: "" });
          }
        }
        rows = expanded;
      }

      const csv = buildCsv(rows);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${type}-export.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setExportStatus(`${type} exported successfully`);
    } catch {
      setExportStatus("Export failed");
    }
  }

  async function handleDownloadBackup() {
    setBackupStatus("Preparing backup…");
    try {
      const res = await fetch("/api/data/export");
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `finlynq-backup-${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupStatus("Backup downloaded successfully");
    } catch {
      setBackupStatus("Backup failed — please try again");
    }
  }

  async function handleRestoreFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setRestoreFile(file);
    setRestorePreview(null);
    setRestoreBackup(null);
    setRestoreStep(0);
    setRestoreStatus("");
    setRestoreConfirm("");
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      setRestoreBackup(parsed);
      // Get preview from server
      const res = await fetch("/api/data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: parsed, confirm: false }),
      });
      if (!res.ok) {
        const err = await res.json();
        setRestoreStatus(err.error ?? "Invalid backup file");
        return;
      }
      const data = await res.json();
      setRestorePreview(data.preview);
      setRestoreStep(1);
    } catch {
      setRestoreStatus("Could not parse backup file — is it a valid Finlynq backup?");
    }
  }

  async function handleRestoreConfirm() {
    if (restoreConfirm !== "RESTORE") {
      setRestoreStatus("Type RESTORE to confirm");
      return;
    }
    setRestoreStatus("Restoring…");
    try {
      const res = await fetch("/api/data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: restoreBackup, confirm: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRestoreStatus(data.error ?? "Restore failed");
        return;
      }
      setRestoreStatus("Restore complete! Reloading…");
      setTimeout(() => window.location.reload(), 1500);
    } catch {
      setRestoreStatus("Restore failed — please try again");
    }
  }

  async function handleClearData() {
    if (clearStep === 0) {
      setClearStep(1);
      return;
    }
    if (clearStep === 1) {
      setClearStep(2);
      return;
    }
    if (clearStep === 2) {
      if (clearConfirm !== "DELETE") {
        setClearStatus("Type DELETE to confirm");
        return;
      }
      try {
        const res = await fetch("/api/data", { method: "DELETE" });
        if (res.ok) {
          setClearStatus("All data cleared successfully");
          setClearStep(0);
          setClearConfirm("");
          loadCategories();
        } else {
          const data = await res.json();
          setClearStatus(data.error || "Failed to clear data");
        }
      } catch {
        setClearStatus("Failed to clear data");
      }
    }
  }

  // Category CRUD
  async function handleEditCategory(id: number) {
    if (!editName.trim()) return;
    setCatError("");
    try {
      const res = await fetch("/api/categories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: editName.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setCatError(data.error || "Failed to update");
        return;
      }
      setEditingId(null);
      setEditName("");
      loadCategories();
    } catch {
      setCatError("Failed to update category");
    }
  }

  async function handleDeleteCategory(id: number) {
    setCatError("");
    try {
      const res = await fetch(`/api/categories?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setCatError(data.error || "Failed to delete");
        return;
      }
      loadCategories();
    } catch {
      setCatError("Failed to delete category");
    }
  }

  async function handleAddCategory(e: React.FormEvent) {
    e.preventDefault();
    const errs: { name?: string; group?: string } = {};
    if (!newCatForm.name.trim()) errs.name = "Name is required";
    if (!newCatForm.group.trim()) errs.group = "Group is required";
    setNewCatErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setCatError("");
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCatForm.name.trim(), type: newCatForm.type, group: newCatForm.group.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setCatError(data.error || "Failed to create");
        return;
      }
      setNewCatForm({ name: "", type: "E", group: "" });
      setNewCatErrors({});
      setShowAddCat(false);
      loadCategories();
    } catch {
      setCatError("Failed to create category");
    }
  }

  // Group categories by group
  const grouped = new Map<string, Category[]>();
  categories.forEach((c) => {
    const group = c.group || "Ungrouped";
    grouped.set(group, [...(grouped.get(group) ?? []), c]);
  });

  // Get unique groups for the add form
  const uniqueGroups = Array.from(new Set(categories.map((c) => c.group).filter(Boolean)));

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your data, preferences, and integrations</p>
      </div>

      {/* Dev Mode Toggle */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
              {devMode ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
            </div>
            <div>
              <CardTitle className="text-base">Dev Mode</CardTitle>
              <CardDescription>Show advanced and experimental features in the navigation</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">
                {devMode ? "Dev mode is ON" : "Dev mode is OFF"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {devMode
                  ? "All 17 advanced features are visible in the nav. Toggle off to see the production view."
                  : "Showing production feature set only (20 features). Toggle on to see all 17 additional features."}
              </p>
            </div>
            <Button
              variant={devMode ? "default" : "outline"}
              size="sm"
              onClick={handleDevModeToggle}
              disabled={devModeLoading}
            >
              {devMode ? <ToggleRight className="h-4 w-4 mr-1.5" /> : <ToggleLeft className="h-4 w-4 mr-1.5" />}
              {devMode ? "Disable" : "Enable"}
            </Button>
          </div>
          {devModeStatus && (
            <p className="text-xs text-muted-foreground">{devModeStatus}</p>
          )}
        </CardContent>
      </Card>

      {/* API Key */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
              <Key className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">API Key</CardTitle>
              <CardDescription>Use this key to connect AI assistants via MCP</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={
                !apiKeyLoaded
                  ? "Loading…"
                  : apiKey
                    ? (apiKeyVisible ? apiKey : `${apiKey.slice(0, 6)}${"•".repeat(20)}${apiKey.slice(-4)}`)
                    : "•".repeat(40)
              }
              className="font-mono text-sm flex-1"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => setApiKeyVisible(!apiKeyVisible)}
              title={apiKeyVisible ? "Hide key" : "Show key"}
              disabled={!apiKey}
            >
              {apiKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopyApiKey}
              title="Copy key"
              disabled={!apiKey}
            >
              {apiKeyCopied ? <Check className="h-4 w-4 text-emerald-500" /> : <FileText className="h-4 w-4" />}
            </Button>
          </div>
          {apiKey && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <strong>Save this key now.</strong> We store only a hash — once you leave this page we can&rsquo;t show it again.
            </div>
          )}
          {apiKeyLoaded && !apiKey && (
            <p className="text-xs text-muted-foreground">
              A key is on file (stored as a hash). Regenerate if you don&rsquo;t have it saved.
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegenerateApiKey}
              disabled={apiKeyRegenerating}
            >
              <RefreshCw className={`h-4 w-4 mr-1.5 ${apiKeyRegenerating ? "animate-spin" : ""}`} />
              {apiKeyRegenerating ? "Regenerating…" : "Regenerate Key"}
            </Button>
            {apiKeyStatus && (
              <p className="text-xs text-muted-foreground">{apiKeyStatus}</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Regenerating invalidates your current key — update any connected MCP clients.
          </p>
        </CardContent>
      </Card>

      {/* Display Preferences */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
              <Settings2 className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Display Preferences</CardTitle>
              <CardDescription>Customize how data is displayed</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Label>Display Currency</Label>
              <p className="text-xs text-muted-foreground">
                Totals and aggregations across the app are converted to this currency.
                Per-row amounts (transactions, holdings) keep their entered currency.
              </p>
            </div>
            <Select value={displayCurrency} onValueChange={handleCurrencyChange}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SUPPORTED_FIAT_CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c} — {currencyLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {currencyError ? (
            <p className="text-sm text-destructive">{currencyError}</p>
          ) : null}
        </CardContent>
      </Card>

      <ActiveCurrenciesSection />

      <FxOverridesSection />

      {/* Security */}
      {/* CSV Import */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-100 text-teal-600">
              <Upload className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Import Data</CardTitle>
              <CardDescription>Import accounts, categories, or portfolio holdings from CSV</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Import type buttons */}
          <div className="grid grid-cols-3 gap-3">
            {([
              { key: "accounts" as const, label: "Accounts", icon: Wallet, color: "text-violet-500", hint: "Columns: name, type, group, currency, note" },
              { key: "categories" as const, label: "Categories", icon: Tag, color: "text-emerald-500", hint: "Columns: name, type, group, note" },
              { key: "portfolio" as const, label: "Portfolio", icon: Briefcase, color: "text-cyan-500", hint: "Columns: symbol, name, quantity, currency, note" },
            ] as const).map(({ key, label, icon: Icon, color, hint }) => (
              <div key={key} className="space-y-1">
                <label className={`flex flex-col items-center gap-2 border rounded-lg p-3 cursor-pointer hover:bg-muted/50 transition-colors text-center ${importSection === key ? "border-primary bg-primary/5" : ""}`}>
                  <Icon className={`h-5 w-5 ${color}`} />
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-[10px] text-muted-foreground">{hint}</span>
                  <input
                    type="file"
                    accept=".csv"
                    className="sr-only"
                    onChange={handleImportFileInput(key)}
                  />
                </label>
              </div>
            ))}
          </div>

          {/* Preview */}
          {importPreview.length > 0 && importSection && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium truncate">{importFileName}</span>
                <Badge variant="outline" className="text-[10px]">Preview</Badge>
              </div>
              <div className="overflow-x-auto rounded border text-xs">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted/50">
                      {importHeaders.map((h) => (
                        <th key={h} className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.map((row, i) => (
                      <tr key={i} className="border-t">
                        {importHeaders.map((h) => (
                          <td key={h} className="px-2 py-1.5 whitespace-nowrap">{row[h] ?? ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground">Showing first {importPreview.length} rows. Full file will be imported on confirm.</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => { setImportPreview([]); setImportSection(null); setImportFileName(""); setImportStatus(""); }}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleImportConfirm} disabled={importLoading}>
                  {importLoading ? "Importing…" : `Import ${importSection}`}
                </Button>
              </div>
            </div>
          )}

          {importStatus && (
            <p className={`text-xs flex items-center gap-1 ${importStatus.includes("fail") || importStatus.includes("error") ? "text-destructive" : "text-muted-foreground"}`}>
              <Upload className="h-3 w-3" /> {importStatus}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Data Export */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Data Export</CardTitle>
              <CardDescription>Export your data as CSV files</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {exportItems.map((item) => (
              <Button key={item.type} variant="outline" className="justify-start h-auto py-3 px-4" onClick={() => handleExport(item.type)}>
                <item.icon className={`h-4 w-4 mr-2 ${item.iconColor}`} />
                <div className="text-left">
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className="text-[10px] text-muted-foreground">Download CSV</p>
                </div>
              </Button>
            ))}
          </div>
          {exportStatus && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Download className="h-3 w-3" /> {exportStatus}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Privacy & Backup */}
      <Card className="border-indigo-200 dark:border-indigo-500/30">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Privacy &amp; Backup</CardTitle>
              <CardDescription>Full backup and restore — your escape hatch if you lose your password</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* AES-256 reminder */}
          <div className="rounded-xl border border-indigo-100 dark:border-indigo-500/20 bg-indigo-50 dark:bg-indigo-500/8 px-4 py-3 text-sm text-indigo-800 dark:text-indigo-300 flex items-start gap-2.5">
            <Lock className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Your data is encrypted with AES-256. Only you hold the key — not even Finlynq can read it.</span>
          </div>

          {/* Download backup */}
          <div>
            <p className="text-sm font-medium text-foreground mb-1.5">Download Full Backup</p>
            <p className="text-xs text-muted-foreground mb-3">
              Exports all your data (accounts, transactions, budgets, portfolio, goals, and more) as a single JSON file.
              Store it somewhere safe — this is how you recover if you ever need to reset your account.
            </p>
            <Button variant="outline" onClick={handleDownloadBackup} className="gap-2">
              <Download className="h-4 w-4" />
              Download Backup
            </Button>
            {backupStatus && (
              <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                <Check className="h-3 w-3 text-emerald-500" /> {backupStatus}
              </p>
            )}
          </div>

          <div className="border-t border-border/50" />

          {/* Restore from backup */}
          <div>
            <p className="text-sm font-medium text-foreground mb-1.5">Restore From Backup</p>
            <p className="text-xs text-muted-foreground mb-3">
              Upload a Finlynq backup JSON file. You will see a preview before anything is changed.
            </p>
            <label className="inline-flex items-center gap-2 cursor-pointer rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors">
              <Upload className="h-4 w-4" />
              Choose Backup File
              <input
                type="file"
                accept=".json"
                className="sr-only"
                onChange={handleRestoreFileChange}
              />
            </label>
            {restoreFile && <span className="ml-3 text-xs text-muted-foreground">{restoreFile.name}</span>}

            {/* Preview */}
            {restoreStep >= 1 && restorePreview && (
              <div className="mt-4 rounded-xl border border-border bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground">Backup contents:</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {Object.entries(restorePreview)
                    .filter(([, v]) => v > 0)
                    .map(([key, count]) => (
                      <div key={key} className="flex items-center justify-between rounded-lg bg-background border border-border/60 px-3 py-2">
                        <span className="text-xs text-muted-foreground capitalize">{key.replace(/([A-Z])/g, " $1").trim()}</span>
                        <span className="text-xs font-semibold text-foreground">{count}</span>
                      </div>
                    ))}
                </div>

                <div className="rounded-lg border border-amber-300/60 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/8 px-3 py-2.5 flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span><strong>This will replace all your current data.</strong> This cannot be undone. Download a fresh backup first if you want to keep your current data.</span>
                </div>

                <div className="flex items-center gap-2">
                  <Input
                    value={restoreConfirm}
                    onChange={(e) => setRestoreConfirm(e.target.value)}
                    placeholder="Type RESTORE to confirm"
                    className="max-w-52 text-sm"
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={restoreConfirm !== "RESTORE"}
                    onClick={handleRestoreConfirm}
                  >
                    Restore
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setRestoreStep(0); setRestoreFile(null); setRestoreConfirm(""); setRestoreStatus(""); setRestorePreview(null); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {restoreStatus && (
              <p className={`text-xs mt-2 flex items-center gap-1 ${restoreStatus.startsWith("Restore complete") ? "text-emerald-600" : "text-muted-foreground"}`}>
                {restoreStatus.startsWith("Restore complete") ? <Check className="h-3 w-3 text-emerald-500" /> : <AlertTriangle className="h-3 w-3 text-amber-500" />}
                {restoreStatus}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Category Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                <Tag className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Category Management</CardTitle>
                <CardDescription>Manage transaction categories</CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowAddCat(!showAddCat)}>
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {catError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {catError}
            </div>
          )}

          {/* Add category form */}
          {showAddCat && (
            <form onSubmit={handleAddCategory} className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Name</Label>
                  <Input value={newCatForm.name} onChange={(e) => { setNewCatForm({ ...newCatForm, name: e.target.value }); setNewCatErrors({ ...newCatErrors, name: "" }); }} placeholder="Category name" />
                  {newCatErrors.name && <p className="text-xs text-destructive mt-1">{newCatErrors.name}</p>}
                </div>
                <div>
                  <Label>Group</Label>
                  <Input
                    value={newCatForm.group}
                    onChange={(e) => { setNewCatForm({ ...newCatForm, group: e.target.value }); setNewCatErrors({ ...newCatErrors, group: "" }); }}
                    placeholder="e.g. Housing"
                    list="cat-groups"
                  />
                  <datalist id="cat-groups">
                    {uniqueGroups.map((g) => <option key={g} value={g} />)}
                  </datalist>
                  {newCatErrors.group && <p className="text-xs text-destructive mt-1">{newCatErrors.group}</p>}
                </div>
                <div>
                  <Label>Type</Label>
                  <Select value={newCatForm.type} onValueChange={(v) => setNewCatForm({ ...newCatForm, type: v ?? "E" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="E">Expense</SelectItem>
                      <SelectItem value="I">Income</SelectItem>
                      <SelectItem value="R">Reconciliation</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">Add Category</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAddCat(false); setNewCatErrors({}); }}>Cancel</Button>
              </div>
            </form>
          )}

          {/* Category list grouped */}
          {Array.from(grouped.entries()).map(([group, cats]) => (
            <div key={group}>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{group}</h4>
              <div className="space-y-1">
                {cats.map((cat) => (
                  <div key={cat.id} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors group">
                    {editingId === cat.id ? (
                      <div className="flex items-center gap-2 flex-1">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-7 text-sm"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleEditCategory(cat.id);
                            if (e.key === "Escape") { setEditingId(null); setEditName(""); }
                          }}
                        />
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditCategory(cat.id)}>
                          <Check className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingId(null); setEditName(""); }}>
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{cat.name}</span>
                          <Badge variant="secondary" className="text-[10px]">
                            {cat.type === "E" ? "Expense" : cat.type === "I" ? "Income" : "Reconciliation"}
                          </Badge>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingId(cat.id); setEditName(cat.name); setCatError(""); }}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteCategory(cat.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {categories.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No categories found</p>
          )}
        </CardContent>
      </Card>

      {/* Transaction Rules */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-100 text-orange-600">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Transaction Rules</CardTitle>
                <CardDescription>Auto-categorize transactions based on rules</CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => { if (showAddRule && editingRuleId) resetRuleForm(); setShowAddRule(!showAddRule); }}>
              <Plus className="h-4 w-4 mr-1" /> Add Rule
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {ruleError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {ruleError}
            </div>
          )}

          {/* Add/Edit rule form */}
          {showAddRule && (
            <form onSubmit={handleSaveRule} className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Rule Name</Label>
                  <Input
                    value={ruleForm.name}
                    onChange={(e) => { setRuleForm({ ...ruleForm, name: e.target.value }); setRuleFormErrors({ ...ruleFormErrors, name: "" }); }}
                    placeholder="e.g. Grocery stores"
                  />
                  {ruleFormErrors.name && <p className="text-xs text-destructive mt-1">{ruleFormErrors.name}</p>}
                </div>
                <div>
                  <Label>Priority</Label>
                  <Input
                    type="number"
                    value={ruleForm.priority}
                    onChange={(e) => setRuleForm({ ...ruleForm, priority: e.target.value })}
                    placeholder="0"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Match Field</Label>
                  <Select value={ruleForm.matchField} onValueChange={(v) => setRuleForm({ ...ruleForm, matchField: v ?? "payee", matchType: (v ?? "payee") === "amount" ? "greater_than" : "contains" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="payee">Payee</SelectItem>
                      <SelectItem value="amount">Amount</SelectItem>
                      <SelectItem value="tags">Tags</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Match Type</Label>
                  <Select value={ruleForm.matchType} onValueChange={(v) => setRuleForm({ ...ruleForm, matchType: v ?? "contains" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {matchTypeOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Match Value</Label>
                  <Input
                    value={ruleForm.matchValue}
                    onChange={(e) => { setRuleForm({ ...ruleForm, matchValue: e.target.value }); setRuleFormErrors({ ...ruleFormErrors, matchValue: "" }); }}
                    placeholder={ruleForm.matchField === "amount" ? "100.00" : "e.g. Walmart"}
                  />
                  {ruleFormErrors.matchValue && <p className="text-xs text-destructive mt-1">{ruleFormErrors.matchValue}</p>}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Assign Category</Label>
                  <Combobox
                    value={ruleForm.assignCategoryId}
                    onValueChange={(v) => setRuleForm({ ...ruleForm, assignCategoryId: v })}
                    items={sortCategory(
                      categories.map((c): ComboboxItemShape => ({ value: c.id.toString(), label: c.name })),
                      (c) => Number(c.value),
                      (a, z) => a.label.localeCompare(z.label),
                    )}
                    placeholder="None"
                    searchPlaceholder="Search categories…"
                    emptyMessage="No matches"
                    className="w-full"
                  />
                </div>
                <div>
                  <Label>Assign Tags</Label>
                  <Input
                    value={ruleForm.assignTags}
                    onChange={(e) => setRuleForm({ ...ruleForm, assignTags: e.target.value })}
                    placeholder="tag1, tag2"
                  />
                </div>
                <div>
                  <Label>Rename To</Label>
                  <Input
                    value={ruleForm.renameTo}
                    onChange={(e) => setRuleForm({ ...ruleForm, renameTo: e.target.value })}
                    placeholder="Clean payee name"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">{editingRuleId ? "Update Rule" : "Add Rule"}</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAddRule(false); resetRuleForm(); }}>Cancel</Button>
              </div>
            </form>
          )}

          {/* Rules list */}
          <div className="space-y-1">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors group">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => handleToggleRule(rule)}
                    className="shrink-0"
                    title={rule.isActive ? "Active — click to disable" : "Inactive — click to enable"}
                  >
                    {rule.isActive ? (
                      <ToggleRight className="h-5 w-5 text-emerald-500" />
                    ) : (
                      <ToggleLeft className="h-5 w-5 text-muted-foreground" />
                    )}
                  </button>
                  <div className="min-w-0">
                    <span className={`text-sm font-medium ${!rule.isActive ? "text-muted-foreground line-through" : ""}`}>{rule.name}</span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant="secondary" className="text-[10px]">{rule.matchField}</Badge>
                      <span className="text-[10px] text-muted-foreground">{rule.matchType}</span>
                      <span className="text-[10px] font-mono text-muted-foreground truncate max-w-32">&ldquo;{rule.matchValue}&rdquo;</span>
                      {rule.categoryName && (
                        <Badge variant="outline" className="text-[10px]">{rule.categoryName}</Badge>
                      )}
                      {rule.priority > 0 && (
                        <span className="text-[10px] text-muted-foreground">P{rule.priority}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditRule(rule)}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteRule(rule.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {rules.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No rules yet. Add rules to auto-categorize transactions.</p>
          )}

          {/* Test rule */}
          <div className="border-t pt-4">
            <Label className="text-xs text-muted-foreground">Test Auto-Suggest</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={testPayee}
                onChange={(e) => setTestPayee(e.target.value)}
                placeholder="Enter a payee name..."
                className="flex-1"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleTestRule(); } }}
              />
              <Button variant="outline" size="sm" onClick={handleTestRule}>
                <Play className="h-3 w-3 mr-1" /> Test
              </Button>
            </div>
            {testResult && (
              <p className="text-xs text-muted-foreground mt-1.5">{testResult}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Data Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100 text-rose-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Data Management</CardTitle>
              <CardDescription>Danger zone - destructive actions</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {clearStep === 0 && (
            <Button variant="outline" className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground" onClick={handleClearData}>
              <Trash2 className="h-4 w-4 mr-2" />
              Clear All Data
            </Button>
          )}

          {clearStep === 1 && (
            <div className="space-y-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
              <p className="text-sm font-medium text-destructive">Are you sure? This will permanently delete all your data.</p>
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" onClick={handleClearData}>Yes, I want to delete everything</Button>
                <Button variant="ghost" size="sm" onClick={() => setClearStep(0)}>Cancel</Button>
              </div>
            </div>
          )}

          {clearStep === 2 && (
            <div className="space-y-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
              <p className="text-sm font-medium text-destructive">Type DELETE to confirm permanent deletion of all data:</p>
              <div className="flex gap-2">
                <Input
                  value={clearConfirm}
                  onChange={(e) => setClearConfirm(e.target.value)}
                  placeholder="Type DELETE"
                  className="max-w-40"
                />
                <Button variant="destructive" size="sm" onClick={handleClearData} disabled={clearConfirm !== "DELETE"}>Confirm</Button>
                <Button variant="ghost" size="sm" onClick={() => { setClearStep(0); setClearConfirm(""); setClearStatus(""); }}>Cancel</Button>
              </div>
            </div>
          )}

          {clearStatus && (
            <p className={`text-xs ${clearStatus.includes("success") ? "text-emerald-600" : "text-destructive"}`}>
              {clearStatus}
            </p>
          )}
        </CardContent>
      </Card>

      {/* MCP Server */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600">
              <Server className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">MCP Server</CardTitle>
              <CardDescription>Connect your AI assistant to your financial data</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The MCP server runs locally and provides read-only access to your financial data.
            AI assistants like Claude, ChatGPT, and Gemini can query your data through it.
          </p>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1.5" />
              Local Only
            </Badge>
            <Badge variant="outline" className="text-xs">
              <Shield className="h-3 w-3 mr-1" />
              Read-only
            </Badge>
          </div>
          <div className="bg-muted/50 p-4 rounded-xl border border-dashed">
            <p className="text-xs font-medium text-muted-foreground mb-2">Claude Desktop configuration:</p>
            <pre className="text-xs overflow-x-auto font-mono leading-relaxed">
{`{
  "mcpServers": {
    "pf": {
      "command": "npx",
      "args": ["tsx", "${process.cwd?.() ?? "/path/to/pf-app"}/mcp-server/index.ts"],
      "env": {
        "PF_PASSPHRASE": "<your passphrase>"
      }
    }
  }
}`}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* About */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">About</CardTitle>
              <CardDescription>Finlynq</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Track your money here, analyze it anywhere.
          </p>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              <Shield className="h-3 w-3 mr-1" />
              Zero-knowledge
            </Badge>
            <Badge variant="secondary" className="text-xs">
              <Database className="h-3 w-3 mr-1" />
              Local-first
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            All data is stored locally on your machine. No data is sent to any server.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
