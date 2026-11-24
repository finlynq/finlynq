/**
 * The user's existing tags and payees, for the tag and payee fields'
 * suggestions. One request per list is shared by every field and kept for a
 * minute; a failure or a locked session just means no suggestions.
 */
import { useCallback, useEffect, useState } from "react";
import { endpoints } from "../api/client";
import type { TagOption } from "../lib/tag-suggest";
import type { PayeeOption } from "../lib/payee-suggest";

const KEEP_MS = 60_000;
let tagCache: { at: number; promise: Promise<TagOption[]> } | null = null;
let payeeCache: { at: number; promise: Promise<PayeeOption[]> } | null = null;

function loadTags(): Promise<TagOption[]> {
  if (tagCache && Date.now() - tagCache.at < KEEP_MS) return tagCache.promise;
  const promise = endpoints
    .getTagOptions()
    .then((r) => (r.success && Array.isArray(r.data?.tags) ? r.data.tags : []))
    .catch(() => []);
  tagCache = { at: Date.now(), promise };
  return promise;
}

function loadPayees(): Promise<PayeeOption[]> {
  if (payeeCache && Date.now() - payeeCache.at < KEEP_MS) return payeeCache.promise;
  const promise = endpoints
    .getPayeeOptions()
    .then((r) => (r.success && Array.isArray(r.data?.payees) ? r.data.payees : []))
    .catch(() => []);
  payeeCache = { at: Date.now(), promise };
  return promise;
}

/** Forget both kept lists (after a save or a cleanup that changed them). */
export function clearNameOptionsCache() {
  tagCache = null;
  payeeCache = null;
}

export function useTagOptions(enabled: boolean): TagOption[] {
  const [options, setOptions] = useState<TagOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadTags().then((o) => {
      if (!cancelled) setOptions(o);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return options;
}

export function usePayeeOptions(enabled: boolean): { options: PayeeOption[]; forget: (id: number) => void } {
  const [options, setOptions] = useState<PayeeOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadPayees().then((o) => {
      if (!cancelled) setOptions(o);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  const forget = useCallback((id: number) => {
    setOptions((prev) => prev.filter((p) => p.id !== id));
    payeeCache = null;
    endpoints.forgetPayee(id).catch(() => {});
  }, []);
  return { options, forget };
}
