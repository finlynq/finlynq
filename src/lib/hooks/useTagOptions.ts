"use client";

/**
 * The user's existing tags with their use counts, for the tag fields'
 * suggestions (GH #449). One fetch of `/api/transactions/tags` is shared by
 * every tag field on the page and kept for a minute; a failure or a locked
 * session just means no suggestions.
 */
import { useEffect, useState } from "react";
import type { TagOption } from "@/lib/transactions/tag-suggest";

const KEEP_MS = 60_000;
let cached: { at: number; promise: Promise<TagOption[]> } | null = null;

function loadTagOptions(): Promise<TagOption[]> {
  if (cached && Date.now() - cached.at < KEEP_MS) return cached.promise;
  const promise = fetch("/api/transactions/tags")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (Array.isArray(d?.data?.tags) ? (d.data.tags as TagOption[]) : []))
    .catch(() => []);
  cached = { at: Date.now(), promise };
  return promise;
}

/** Forget the kept list (after a save that may have added tags). */
export function clearTagOptionsCache() {
  cached = null;
}

export function useTagOptions(enabled = true): TagOption[] {
  const [options, setOptions] = useState<TagOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadTagOptions().then((o) => {
      if (!cancelled) setOptions(o);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return options;
}
