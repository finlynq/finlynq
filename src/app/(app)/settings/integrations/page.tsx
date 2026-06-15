"use client";

/**
 * /settings/integrations — MCP server reference (issue #57) + Connected apps
 * (FINLYNQ-154 — per-user OAuth grant list + revoke).
 * Extracted from the monolith /settings/page.tsx.
 */

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Server, Shield } from "lucide-react";
import { ConnectedApps } from "./connected-apps";

export default function IntegrationsSettingsPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-0.5">External tools that connect to your data</p>
      </div>

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
            The MCP server lets AI assistants like Claude and ChatGPT query and manage your
            financial data in natural language. It exposes 102 tools over HTTP and 93 over stdio —
            accounts, transactions, budgets, portfolio, goals, loans, and imports. Destructive
            actions (deletes, bulk edits) always use a preview-then-confirm step.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1.5" />
              HTTP + stdio
            </Badge>
            <Badge variant="outline" className="text-xs">
              <Shield className="h-3 w-3 mr-1" />
              OAuth 2.1 / API key
            </Badge>
            <Badge variant="outline" className="text-xs">
              Read + write
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Easiest setup is Claude or ChatGPT over HTTP with OAuth — no keys to paste. The{" "}
            <a href="/mcp-guide" className="underline underline-offset-2 hover:text-foreground">
              Connect Your AI guide
            </a>{" "}
            has step-by-step setup for every client (Claude, ChatGPT, Cursor, Windsurf, Cline),
            example prompts, and troubleshooting.
          </p>
          <div className="bg-muted/50 p-4 rounded-xl border border-dashed">
            <p className="text-xs font-medium text-muted-foreground mb-2">Self-hosted stdio configuration (Claude Desktop):</p>
            <pre className="text-xs overflow-x-auto font-mono leading-relaxed">
{`{
  "mcpServers": {
    "pf": {
      "command": "npx",
      "args": ["tsx", "${typeof process !== "undefined" && process.cwd?.() ? process.cwd() : "/path/to/pf-app"}/mcp-server/index.ts"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/pf",
        "PF_USER_ID": "your-user-uuid-from-users-table"
      }
    }
  }
}`}
            </pre>
          </div>
        </CardContent>
      </Card>

      <ConnectedApps />
    </div>
  );
}
