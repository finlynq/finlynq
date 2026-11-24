"use client";

/**
 * The user's payee list for the Payee field's suggestions. One fetch of
 * `/api/payees` is shared by every payee field on the page and kept for a
 * minute; a failure or a locked session just means no suggestions.
 */
import { useCallback, useEffect, useState } from "react";
import type { PayeeOption } from "@/lib/payees/suggest";

const KEEP_MS = 60_000;
let cached: { at: number; promise: Promise<PayeeOption[]> } | null = null;

function loadPayeeOptions(): Promise<PayeeOption[]> {
  if (cached && Date.now() - cached.at < KEEP_MS) return cached.promise;
  const promise = fetch("/api/payees")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (Array.isArray(d?.data?.payees) ? (d.data.payees as PayeeOption[]) : []))
    .catch(() => []);
  cached = { at: Date.now(), promise };
  return promise;
}

/** Forget the kept list (after a save that may have added a payee). */
export function clearPayeeOptionsCache() {
  cached = null;
}

export function usePayeeOptions(enabled = true): {
  options: PayeeOption[];
  /** Take one payee out of the suggestions (server + this list). */
  forget: (id: number) => void;
} {
  const [options, setOptions] = useState<PayeeOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadPayeeOptions().then((o) => {
      if (!cancelled) setOptions(o);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  const forget = useCallback((id: number) => {
    setOptions((prev) => prev.filter((p) => p.id !== id));
    cached = null;
    void fetch("/api/payees", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }, []);
  return { options, forget };
}
