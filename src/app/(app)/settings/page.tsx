"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Database, Server, Shield, Wallet, Tag, ArrowLeftRight, Briefcase, Trash2, Pencil, Plus, AlertTriangle, Settings2, Check, X, Zap, ToggleLeft, ToggleRight, Play, Lock, Eye, EyeOff, FolderOpen, HardDrive, Cloud, RefreshCw, BarChart3, CreditCard } from "lucide-react";

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
  const [currency, setCurrency] = useState("CAD");
  const [clearConfirm, setClearConfirm] = useState("");
  const [clearStep, setClearStep] = useState(0); // 0=idle, 1=first confirm, 2=type DELETE
  const [clearStatus, setClearStatus] = useState("");

  // Category management
  const [categories, setCategories] = useState<Category[]>([]);
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

  // Security
  const [showRekey, setShowRekey] = useState(false);
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmNewPass, setConfirmNewPass] = useState("");
  const [showPassFields, setShowPassFields] = useState(false);
  const [rekeyStatus, setRekeyStatus] = useState("");
  const [rekeyLoading, setRekeyLoading] = useState(false);

  // Storage
  const [storageInfo, setStorageInfo] = useState<{ dbPath: string; resolvedPath: string; mode: string; fileSize: number } | null>(null);
  const [editDbPath, setEditDbPath] = useState("");
  const [editMode, setEditMode] = useState<"local" | "cloud">("local");
  const [storageStatus, setStorageStatus] = useState("");
  const [showEditStorage, setShowEditStorage] = useState(false);

  // Sync status
  const [syncStatus, setSyncStatus] = useState<{ mode: string; readOnly?: boolean; lock?: { locked: boolean; holder?: string; hostname?: string; timestamp?: number; stale?: boolean }; conflictFiles?: string[] } | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);

  // Dev mode
  const [devMode, setDevMode] = useState(false);
  const [devModeLoading, setDevModeLoading] = useState(false);
  const [devModeStatus, setDevModeStatus] = useState("");

  // Billing
  const [billingStatus, setBillingStatus] = useState<{ plan: string; planExpiresAt: string | null; stripeCustomerId: string | null } | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);

  // ETF Data
  const [etfData, setEtfData] = useState<{ etfs: { symbol: string; full_name: string; total_holdings: number; updated_at: string }[]; count: number } | null>(null);
  const [etfLoading, setEtfLoading] = useState(false);
  const [etfStatus, setEtfStatus] = useState("");

  // Load dev mode
  useEffect(() => {
    fetch("/api/settings/dev-mode")
      .then((r) => r.json())
      .then((data) => { if (typeof data.devMode === "boolean") setDevMode(data.devMode); })
      .catch(() => {});
  }, []);

  // Load billing status (managed mode only — silently fails in self-hosted)
  useEffect(() => {
    fetch("/api/billing/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.plan) setBillingStatus(data); })
      .catch(() => {});
  }, []);

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

  async function handleBillingUpgrade() {
    setBillingLoading(true);
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST" });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      // ignore — user stays on page
    } finally {
      setBillingLoading(false);
    }
  }

  // Load currency from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("pf-currency");
    if (saved) setCurrency(saved);
  }, []);

  function handleCurrencyChange(val: string | null) {
    const v = val ?? "CAD";
    setCurrency(v);
    localStorage.setItem("pf-currency", v);
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

  // Load ETF data
  const loadEtfData = useCallback(() => {
    fetch("/api/portfolio/etf-data").then((r) => r.json()).then(setEtfData).catch(() => {});
  }, []);
  useEffect(() => { loadEtfData(); }, [loadEtfData]);

  const handleSeedEtfs = async () => {
    setEtfLoading(true);
    setEtfStatus("");
    try {
      const res = await fetch("/api/portfolio/etf-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed" }),
      });
      const data = await res.json();
      if (data.success) {
        setEtfStatus(`Seeded ${data.seeded} ETFs`);
        loadEtfData();
      } else {
        setEtfStatus(`Error: ${data.error}`);
      }
    } catch {
      setEtfStatus("Failed to seed ETF data");
    }
    setEtfLoading(false);
  };

  // Load storage info
  const loadStorageInfo = useCallback(() => {
    fetch("/api/settings/storage").then((r) => r.json()).then((data) => {
      setStorageInfo(data);
      setEditDbPath(data.dbPath);
      setEditMode(data.mode);
    }).catch(() => {});
  }, []);

  useEffect(() => { loadStorageInfo(); }, [loadStorageInfo]);

  // Load sync status
  const loadSyncStatus = useCallback(() => {
    fetch("/api/settings/sync-status").then((r) => r.json()).then(setSyncStatus).catch(() => {});
  }, []);

  useEffect(() => { loadSyncStatus(); }, [loadSyncStatus]);

  async function handleRekey(e: React.FormEvent) {
    e.preventDefault();
    if (newPass !== confirmNewPass) { setRekeyStatus("New passphrases do not match"); return; }
    if (newPass.length < 8) { setRekeyStatus("New passphrase must be at least 8 characters"); return; }
    setRekeyLoading(true);
    setRekeyStatus("");
    try {
      const res = await fetch("/api/auth/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rekey", passphrase: currentPass, newPassphrase: newPass }),
      });
      const data = await res.json();
      if (data.success) {
        setRekeyStatus("Passphrase changed successfully");
        setShowRekey(false);
        setCurrentPass("");
        setNewPass("");
        setConfirmNewPass("");
      } else {
        setRekeyStatus(data.error || "Failed to change passphrase");
      }
    } catch {
      setRekeyStatus("Failed to change passphrase");
    } finally {
      setRekeyLoading(false);
    }
  }

  async function handleUpdateStorage() {
    setStorageStatus("");
    try {
      const res = await fetch("/api/settings/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbPath: editDbPath, mode: editMode }),
      });
      const data = await res.json();
      if (data.success) {
        setStorageStatus(data.message);
        setShowEditStorage(false);
        loadStorageInfo();
      } else {
        setStorageStatus(data.error || "Failed to update");
      }
    } catch {
      setStorageStatus("Failed to update storage settings");
    }
  }

  async function handleForceReleaseLock() {
    setSyncLoading(true);
    try {
      const res = await fetch("/api/settings/sync-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "force-release" }),
      });
      await res.json();
      loadSyncStatus();
    } catch {
      // best effort
    } finally {
      setSyncLoading(false);
    }
  }

  async function handleLockApp() {
    await fetch("/api/auth/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "lock" }),
    });
    window.location.reload();
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

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

  async function handleExport(type: string) {
    setExportStatus(`Exporting ${type}...`);
    try {
      const res = await fetch(`/api/${type}`);
      const data = await res.json();
      const rows = Array.isArray(data) ? data : data.data ?? [];

      if (rows.length === 0) {
        setExportStatus("No data to export");
        return;
      }

      const headers = Object.keys(rows[0]);
      const csv = [
        headers.join(","),
        ...rows.map((row: Record<string, unknown>) =>
          headers.map((h) => {
            const val = String(row[h] ?? "");
            return val.includes(",") ? `"${val}"` : val;
          }).join(",")
        ),
      ].join("\n");

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

      {/* Plan & Billing — only shown in managed mode */}
      {billingStatus && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Plan &amp; Billing</CardTitle>
                <CardDescription>Manage your subscription</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium capitalize">{billingStatus.plan} plan</p>
                {billingStatus.plan === "trial" && billingStatus.planExpiresAt && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Trial expires{" "}
                    {new Date(billingStatus.planExpiresAt).toLocaleDateString(undefined, {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                )}
                {billingStatus.plan === "free" && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Upgrade to Pro for full access
                  </p>
                )}
                {(billingStatus.plan === "pro" || billingStatus.plan === "premium") && billingStatus.planExpiresAt && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Renews{" "}
                    {new Date(billingStatus.planExpiresAt).toLocaleDateString(undefined, {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                )}
              </div>
              {(billingStatus.plan === "free" || billingStatus.plan === "trial") && (
                <Button
                  size="sm"
                  onClick={handleBillingUpgrade}
                  disabled={billingLoading}
                >
                  <Zap className="h-4 w-4 mr-1.5" />
                  {billingLoading ? "Redirecting…" : "Upgrade to Pro"}
                </Button>
              )}
              {billingStatus.stripeCustomerId && (billingStatus.plan === "pro" || billingStatus.plan === "premium") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBillingUpgrade}
                  disabled={billingLoading}
                >
                  Manage billing
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

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
              <Label>Default Currency</Label>
              <p className="text-xs text-muted-foreground">Used for displaying amounts across the app</p>
            </div>
            <Select value={currency} onValueChange={handleCurrencyChange}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CAD">CAD</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Security</CardTitle>
              <CardDescription>Encryption and passphrase settings</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                <Shield className="h-3 w-3 mr-1" />
                AES-256 Encrypted
              </Badge>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowRekey(!showRekey)}>
              <Lock className="h-3 w-3 mr-1" /> Change Passphrase
            </Button>
            <Button variant="outline" size="sm" onClick={handleLockApp}>
              <Lock className="h-3 w-3 mr-1" /> Lock App
            </Button>
          </div>

          {showRekey && (
            <form onSubmit={handleRekey} className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div>
                <Label>Current Passphrase</Label>
                <div className="relative">
                  <input
                    type={showPassFields ? "text" : "password"}
                    value={currentPass}
                    onChange={(e) => setCurrentPass(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    autoComplete="current-password"
                  />
                </div>
              </div>
              <div>
                <Label>New Passphrase</Label>
                <input
                  type={showPassFields ? "text" : "password"}
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  autoComplete="new-password"
                />
              </div>
              <div>
                <Label>Confirm New Passphrase</Label>
                <input
                  type={showPassFields ? "text" : "password"}
                  value={confirmNewPass}
                  onChange={(e) => setConfirmNewPass(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  autoComplete="new-password"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={showPassFields} onChange={(e) => setShowPassFields(e.target.checked)} />
                Show passphrases
              </label>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={rekeyLoading}>
                  {rekeyLoading ? "Changing..." : "Change Passphrase"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowRekey(false); setCurrentPass(""); setNewPass(""); setConfirmNewPass(""); }}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {rekeyStatus && (
            <p className={`text-xs ${rekeyStatus.includes("success") ? "text-emerald-600" : "text-destructive"}`}>
              {rekeyStatus}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Storage */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600">
              <HardDrive className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Storage</CardTitle>
              <CardDescription>Database location and sync mode</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {storageInfo && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Mode</span>
                <Badge variant={storageInfo.mode === "cloud" ? "default" : "secondary"} className="text-xs">
                  {storageInfo.mode === "cloud" ? <Cloud className="h-3 w-3 mr-1" /> : <HardDrive className="h-3 w-3 mr-1" />}
                  {storageInfo.mode === "cloud" ? "Cloud Sync" : "Local"}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Location</span>
                <span className="text-sm font-mono truncate max-w-64">{storageInfo.resolvedPath}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Size</span>
                <span className="text-sm">{formatBytes(storageInfo.fileSize)}</span>
              </div>
            </div>
          )}

          <Button variant="outline" size="sm" onClick={() => setShowEditStorage(!showEditStorage)}>
            <FolderOpen className="h-3 w-3 mr-1" /> Change Location
          </Button>

          {showEditStorage && (
            <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div>
                <Label>Database Path</Label>
                <Input value={editDbPath} onChange={(e) => setEditDbPath(e.target.value)} placeholder="./pf.db or /path/to/cloud/folder/pf.db" />
              </div>
              <div>
                <Label>Mode</Label>
                <div className="flex gap-2 mt-1">
                  <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer text-sm ${editMode === "local" ? "border-indigo-500 bg-indigo-500/5" : "border-border"}`}>
                    <input type="radio" name="edit-mode" value="local" checked={editMode === "local"} onChange={() => setEditMode("local")} className="accent-indigo-600" />
                    <HardDrive className="h-3.5 w-3.5" /> Local
                  </label>
                  <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer text-sm ${editMode === "cloud" ? "border-indigo-500 bg-indigo-500/5" : "border-border"}`}>
                    <input type="radio" name="edit-mode" value="cloud" checked={editMode === "cloud"} onChange={() => setEditMode("cloud")} className="accent-indigo-600" />
                    <Cloud className="h-3.5 w-3.5" /> Cloud Sync
                  </label>
                </div>
              </div>
              {editMode === "cloud" && (
                <p className="text-xs text-amber-600">Cloud mode uses rollback journal (no WAL) for single-file sync compatibility.</p>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={handleUpdateStorage}>Save</Button>
                <Button variant="ghost" size="sm" onClick={() => setShowEditStorage(false)}>Cancel</Button>
              </div>
            </div>
          )}

          {storageStatus && (
            <p className={`text-xs ${storageStatus.includes("updated") || storageStatus.includes("Restart") ? "text-amber-600" : "text-destructive"}`}>
              {storageStatus}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Sync Status (cloud mode only) */}
      {syncStatus && syncStatus.mode === "cloud" && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                <RefreshCw className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Sync Status</CardTitle>
                <CardDescription>Cloud drive sync and lock status</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Access</span>
              <Badge variant={syncStatus.readOnly ? "destructive" : "default"} className="text-xs">
                {syncStatus.readOnly ? "Read-only" : "Write access"}
              </Badge>
            </div>

            {syncStatus.lock?.locked && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Locked by</span>
                  <span className="text-sm">{syncStatus.lock.hostname || syncStatus.lock.holder}</span>
                </div>
                {syncStatus.lock.timestamp && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Since</span>
                    <span className="text-sm">{new Date(syncStatus.lock.timestamp).toLocaleString()}</span>
                  </div>
                )}
                {syncStatus.lock.stale && (
                  <p className="text-xs text-amber-600">This lock appears stale (no heartbeat for 5+ minutes)</p>
                )}
                <Button variant="outline" size="sm" onClick={handleForceReleaseLock} disabled={syncLoading}>
                  {syncLoading ? "Releasing..." : "Force Release Lock"}
                </Button>
              </div>
            )}

            {syncStatus.conflictFiles && syncStatus.conflictFiles.length > 0 && (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
                <p className="text-xs text-amber-700 dark:text-amber-400 font-medium mb-1">
                  Conflict files detected ({syncStatus.conflictFiles.length}):
                </p>
                {syncStatus.conflictFiles.map((f) => (
                  <p key={f} className="text-xs text-amber-600 font-mono truncate">{f}</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
                  <Select value={ruleForm.assignCategoryId} onValueChange={(v) => setRuleForm({ ...ruleForm, assignCategoryId: v ?? "" })}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">None</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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

      {/* ETF Data (Shared Database) */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-100 text-teal-600">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">ETF Data</CardTitle>
              <CardDescription>Shared ETF breakdown database — regions, sectors, and constituents</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={handleSeedEtfs} disabled={etfLoading}>
              <Database className="h-3.5 w-3.5 mr-1.5" />
              {etfLoading ? "Seeding…" : "Seed from Defaults"}
            </Button>
            {etfStatus && <span className="text-xs text-muted-foreground">{etfStatus}</span>}
          </div>

          {etfData && etfData.count > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{etfData.count} ETFs in database</p>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      <th className="px-3 py-1.5 font-medium text-xs">Symbol</th>
                      <th className="px-3 py-1.5 font-medium text-xs">Name</th>
                      <th className="px-3 py-1.5 font-medium text-xs text-right">Holdings</th>
                      <th className="px-3 py-1.5 font-medium text-xs text-right">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {etfData.etfs.map((etf) => (
                      <tr key={etf.symbol} className="border-t border-border/50">
                        <td className="px-3 py-1.5 font-mono text-xs">{etf.symbol}</td>
                        <td className="px-3 py-1.5 text-xs text-muted-foreground truncate max-w-[200px]">{etf.full_name}</td>
                        <td className="px-3 py-1.5 text-xs text-right">{etf.total_holdings}</td>
                        <td className="px-3 py-1.5 text-xs text-right text-muted-foreground">
                          {new Date(etf.updated_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No ETF data in database. Click &quot;Seed from Defaults&quot; to populate.</p>
          )}
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
              <CardDescription>PersonalFi - Personal Finance</CardDescription>
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
