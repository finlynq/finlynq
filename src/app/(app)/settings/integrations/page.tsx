"use client";

/**
 * /settings/integrations — Connected apps (FINLYNQ-154 — per-user OAuth grant
 * list + revoke).
 *
 * The MCP server setup reference that used to live here was removed: MCP setup
 * now has a single home, the in-app "MCP Guide" (/connect) reachable from the
 * sidebar, so this page is dedicated to managing already-connected apps.
 */

import { ConnectedApps } from "./connected-apps";

export default function IntegrationsSettingsPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-0.5">External tools that connect to your data</p>
      </div>

      <ConnectedApps />
    </div>
  );
}
