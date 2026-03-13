"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Database, Server, Shield, Wallet, Tag, ArrowLeftRight, Briefcase } from "lucide-react";

const exportItems = [
  { type: "accounts", label: "Accounts", icon: Wallet, iconColor: "text-violet-500" },
  { type: "categories", label: "Categories", icon: Tag, iconColor: "text-emerald-500" },
  { type: "transactions", label: "Transactions", icon: ArrowLeftRight, iconColor: "text-amber-500" },
  { type: "portfolio", label: "Portfolio", icon: Briefcase, iconColor: "text-cyan-500" },
];

export default function SettingsPage() {
  const [exportStatus, setExportStatus] = useState("");

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

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your data and integrations</p>
      </div>

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
      "command": "node",
      "args": ["${process.cwd?.() ?? "/path/to/pf-app"}/mcp-server/index.js"]
    }
  }
}`}
            </pre>
          </div>
        </CardContent>
      </Card>

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
