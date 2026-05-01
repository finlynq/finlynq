"use client";

/**
 * /settings/account — API Key + Privacy & Backup (issue #57).
 * Extracted from the monolith /settings/page.tsx.
 */

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Key, RefreshCw, Eye, EyeOff, FileText, Check, Shield, Lock, Download, Upload, AlertTriangle } from "lucide-react";

export default function AccountSettingsPage() {
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

  // Backup / restore
  const [backupStatus, setBackupStatus] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePreview, setRestorePreview] = useState<Record<string, number> | null>(null);
  const [restoreBackup, setRestoreBackup] = useState<unknown>(null);
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [restoreStep, setRestoreStep] = useState(0); // 0=idle, 1=preview, 2=type RESTORE
  const [restoreStatus, setRestoreStatus] = useState("");

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

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Account & Security</h1>
        <p className="text-sm text-muted-foreground mt-0.5">API key, privacy, and backup / restore</p>
      </div>

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
    </div>
  );
}
