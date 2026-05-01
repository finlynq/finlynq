"use client";

/**
 * /settings/integrations — MCP server reference (issue #57).
 * Extracted from the monolith /settings/page.tsx.
 */

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Server, Shield } from "lucide-react";

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
      "args": ["tsx", "${typeof process !== "undefined" && process.cwd?.() ? process.cwd() : "/path/to/pf-app"}/mcp-server/index.ts"],
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
    </div>
  );
}
