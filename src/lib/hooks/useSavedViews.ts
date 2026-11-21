"use client";

/**
 * Saved reports / saved Transactions views for one page (GH #427): the list
 * from `GET /api/saved-views?kind=` plus the writes behind it. Bespoke fetch
 * (no SWR), like the other settings-style lists. Every write returns
 * `{ ok, error }` so the calling dialog can stay open with the server's
 * message (`parseSaveError`, 423 → the locked message).
 */
import { useCallback, useEffect, useState } from "react";
import { parseSaveError } from "@/lib/save-error";
import type { SavedView, SavedViewConfig, SavedViewKind } from "@/lib/saved-views/config";

export type SavedViewWrite = { ok: true; view?: SavedView } | { ok: false; error: string };

export function useSavedViews(kind: SavedViewKind) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/saved-views?kind=${kind}`);
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { data?: { views?: SavedView[] } };
      setViews(json.data?.views ?? []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoaded(true);
    }
  }, [kind]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const send = useCallback(
    async (url: string, method: "POST" | "PUT" | "DELETE", body?: unknown, fallback = "Couldn't save. Please try again."): Promise<SavedViewWrite> => {
      try {
        const res = await fetch(url, {
          method,
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) return { ok: false, error: await parseSaveError(res, fallback) };
        const json = (await res.json().catch(() => null)) as { data?: { view?: SavedView } } | null;
        await reload();
        return { ok: true, view: json?.data?.view };
      } catch {
        return { ok: false, error: "Couldn't reach Finlynq. Check your connection and try again." };
      }
    },
    [reload],
  );

  const create = useCallback(
    (name: string, config: SavedViewConfig, isDefault = false) =>
      send("/api/saved-views", "POST", { kind, name, config, isDefault }),
    [kind, send],
  );
  const update = useCallback(
    (id: number, patch: { name?: string; config?: SavedViewConfig; isDefault?: boolean }) =>
      send(`/api/saved-views/${id}`, "PUT", patch),
    [send],
  );
  const remove = useCallback(
    (id: number) => send(`/api/saved-views/${id}`, "DELETE", undefined, "Couldn't delete. Please try again."),
    [send],
  );

  return { views, loaded, loadError, reload, create, update, remove };
}
