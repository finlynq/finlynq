"use client";

import { useMemo, useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BookTemplate, Sparkles, Wand2 } from "lucide-react";
import {
  scoreTemplateMatch,
  type ImportTemplate,
} from "@/lib/import-templates";

interface TemplatePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: ImportTemplate[];
  fileHeaders: string[];
  fileName: string;
  onContinue: (templateId: number | null) => void;
}

const AUTO_DETECT = "__auto__" as const;
type Selection = number | typeof AUTO_DETECT;

export function TemplatePickerDialog({
  open,
  onOpenChange,
  templates,
  fileHeaders,
  fileName,
  onContinue,
}: TemplatePickerDialogProps) {
  const scored = useMemo(() => {
    return templates
      .map((t) => ({ template: t, score: scoreTemplateMatch(fileHeaders, t.fileHeaders) }))
      .sort((a, b) => b.score - a.score);
  }, [templates, fileHeaders]);

  const bestMatch = scored[0] && scored[0].score >= 80 ? scored[0] : null;
  const defaultSelection: Selection = bestMatch ? bestMatch.template.id : AUTO_DETECT;

  const [selection, setSelection] = useState<Selection>(defaultSelection);

  // Reset selection when the dialog opens for a new file
  useEffect(() => {
    if (open) setSelection(defaultSelection);
  }, [open, defaultSelection]);

  const handleContinue = () => {
    onContinue(selection === AUTO_DETECT ? null : selection);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Pick an import template</DialogTitle>
          <DialogDescription>
            We found <span className="font-medium text-foreground">{fileHeaders.length}</span> columns in{" "}
            <span className="font-mono text-foreground">{fileName}</span>. Choose how to parse it, or let Finlynq auto-detect.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-auto flex-1 -mx-6 px-6 space-y-2">
          {scored.map(({ template, score }, idx) => {
            const isBest = bestMatch?.template.id === template.id;
            const isSelected = selection === template.id;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => setSelection(template.id)}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${
                  isSelected
                    ? "border-blue-500/60 bg-blue-500/10"
                    : "border-border bg-card hover:bg-muted/40"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    <span
                      className={`block h-4 w-4 rounded-full border-2 ${
                        isSelected
                          ? "border-blue-500 bg-blue-500"
                          : "border-muted-foreground/40"
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <BookTemplate className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{template.name}</span>
                      {isBest && (
                        <Badge className="bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/30 text-[10px]">
                          <Sparkles className="h-3 w-3 mr-0.5" />
                          Best match
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className={`text-[10px] ml-auto ${
                          score >= 80
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                            : score >= 50
                              ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
                              : "bg-muted text-muted-foreground border-border"
                        }`}
                      >
                        {score}% match
                      </Badge>
                    </div>
                    {template.defaultAccount && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Default account: <span className="font-mono">{template.defaultAccount}</span>
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground/80 mt-1 truncate">
                      Columns: {template.fileHeaders.slice(0, 5).join(", ")}
                      {template.fileHeaders.length > 5 && ` +${template.fileHeaders.length - 5} more`}
                    </p>
                  </div>
                </div>
                {idx === 0 && scored.length > 1 && score < 80 && (
                  <p className="text-[11px] text-muted-foreground mt-2 ml-7">
                    No template scores ≥80% — auto-detect may work better.
                  </p>
                )}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setSelection(AUTO_DETECT)}
            className={`w-full text-left rounded-lg border p-3 transition-colors ${
              selection === AUTO_DETECT
                ? "border-blue-500/60 bg-blue-500/10"
                : "border-dashed border-border bg-card hover:bg-muted/40"
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 shrink-0">
                <span
                  className={`block h-4 w-4 rounded-full border-2 ${
                    selection === AUTO_DETECT
                      ? "border-blue-500 bg-blue-500"
                      : "border-muted-foreground/40"
                  }`}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Wand2 className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium text-sm">Auto-detect (no template)</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Try canonical headers (Date / Amount / Account / Payee). Falls back to column mapping if that fails.
                </p>
              </div>
            </div>
          </button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleContinue}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Extract CSV headers from a File client-side. Reads only the first
 * ~64KB so we don't pull a 50MB statement into memory just to score
 * templates. Returns [] for empty / unreadable files; the page will
 * then fall through to the regular preview path.
 */
export async function extractCsvHeadersFromFile(file: File): Promise<string[]> {
  const head = file.slice(0, 64 * 1024);
  const text = (await head.text()).replace(/^﻿/, "");
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
  if (!firstLine) return [];
  return parseCsvHeaderRow(firstLine);
}

/** Minimal RFC-4180 header-row parser (quotes + escaped quotes). */
function parseCsvHeaderRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}
