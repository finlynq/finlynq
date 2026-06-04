"use client";

/**
 * ImportPrefsPicker — per-account import field-mapping preferences for the
 * account detail page (2026-06-04).
 *
 * Two persisted controls, both PATCHing /api/accounts/[id]/import-prefs:
 *   - Field-mapping confirmation: 'confirm' (show the CSV column-mapping /
 *     OFX field-mapping preview before staging) vs 'auto' (apply silently).
 *   - OFX/QFX payee default: which field (Name vs Memo) becomes the payee.
 *
 * This is the canonical home for RESETTING an account that was set to "apply
 * automatically" back to "ask me first" — once 'auto', the upload preview
 * never re-appears, so there'd otherwise be no way back. Saves immediately on
 * change (one click to reset) with a transient "Saved" indicator.
 */

import { useState } from "react";
import { Check } from "lucide-react";

export type CsvMappingMode = "confirm" | "auto";
export type OfxPayeeSource = "name" | "memo";

function Radio<T extends string>({
  name,
  options,
  value,
  onChange,
  disabled,
}: {
  name: string;
  options: { value: T; label: string; hint: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" className="space-y-1.5">
      {options.map((opt) => (
        <label
          key={opt.value}
          className={`flex items-start gap-2 text-sm ${
            disabled ? "opacity-60" : "cursor-pointer"
          }`}
        >
          <input
            type="radio"
            name={name}
            className="mt-0.5"
            checked={value === opt.value}
            disabled={disabled}
            onChange={() => onChange(opt.value)}
          />
          <span>
            <span className="font-medium">{opt.label}</span>
            <span className="block text-[11px] text-muted-foreground">
              {opt.hint}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

export function ImportPrefsPicker({
  accountId,
  initialCsvMappingMode,
  initialOfxPayeeSource,
  onSaved,
}: {
  accountId: number;
  initialCsvMappingMode: CsvMappingMode;
  initialOfxPayeeSource: OfxPayeeSource;
  onSaved?: (prefs: {
    csvMappingMode: CsvMappingMode;
    ofxPayeeSource: OfxPayeeSource;
  }) => void;
}) {
  const [csvMode, setCsvMode] = useState<CsvMappingMode>(initialCsvMappingMode);
  const [payeeSource, setPayeeSource] =
    useState<OfxPayeeSource>(initialOfxPayeeSource);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(
    prefs: Partial<{ csvMappingMode: CsvMappingMode; ofxPayeeSource: OfxPayeeSource }>,
  ) {
    setSaving(true);
    setError(null);
    setSavedAt(false);
    try {
      const res = await fetch(`/api/accounts/${accountId}/import-prefs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.success === false) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSavedAt(true);
      onSaved?.({
        csvMappingMode: body.data?.csvMappingMode ?? csvMode,
        ofxPayeeSource: body.data?.ofxPayeeSource ?? payeeSource,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Confirm before importing</p>
        <Radio
          name={`csv-mode-${accountId}`}
          value={csvMode}
          disabled={saving}
          onChange={(v) => {
            setCsvMode(v);
            void patch({ csvMappingMode: v });
          }}
          options={[
            {
              value: "confirm",
              label: "Ask me to confirm first",
              hint: "Show the CSV column mapping / OFX field preview before any rows are staged.",
            },
            {
              value: "auto",
              label: "Apply automatically",
              hint: "Import silently using the detected mapping / saved payee source.",
            },
          ]}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium">OFX/QFX payee comes from</p>
        <Radio
          name={`ofx-payee-${accountId}`}
          value={payeeSource}
          disabled={saving}
          onChange={(v) => {
            setPayeeSource(v);
            void patch({ ofxPayeeSource: v });
          }}
          options={[
            {
              value: "name",
              label: "Name field",
              hint: "Default. The Memo becomes the transaction Note.",
            },
            {
              value: "memo",
              label: "Memo field",
              hint: "For banks that put the merchant in Memo and a generic label in Name.",
            },
          ]}
        />
      </div>

      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      )}
      {savedAt && !saving && !error && (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <Check className="h-3.5 w-3.5" />
          Saved
        </span>
      )}
    </div>
  );
}
