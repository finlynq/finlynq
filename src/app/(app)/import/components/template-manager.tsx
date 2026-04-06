"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, BookmarkCheck, RefreshCw } from "lucide-react";

interface ImportTemplate {
  id: number;
  name: string;
  fileType: string;
  headers: string[];
  columnMapping: Record<string, string>;
  defaultAccount: string;
  isDefault: number;
  createdAt: string;
}

export function TemplateManager() {
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/import/templates");
      if (res.ok) {
        const data = await res.json() as ImportTemplate[];
        setTemplates(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await fetch(`/api/import/templates/${id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
    }
  };

  const FIELD_LABELS: Record<string, string> = {
    date: "Date",
    amount: "Amount",
    account: "Account",
    payee: "Payee",
    category: "Category",
    currency: "Currency",
    note: "Note",
    tags: "Tags",
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin mx-auto mb-2" />
          Loading templates…
        </CardContent>
      </Card>
    );
  }

  if (templates.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <BookmarkCheck className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-medium text-muted-foreground">No saved templates</p>
          <p className="text-xs text-muted-foreground mt-1">
            Upload a CSV with custom columns and save the mapping as a template.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <BookmarkCheck className="h-4 w-4 text-primary" />
          Saved Templates ({templates.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {templates.map((t) => (
          <div key={t.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{t.name}</span>
                <Badge variant="secondary" className="text-[10px] uppercase">
                  {t.fileType}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {Object.entries(t.columnMapping).map(([field, header]) => (
                  <span key={field} className="text-[10px] rounded bg-muted px-1.5 py-0.5 font-mono">
                    {FIELD_LABELS[field] ?? field}: {header}
                  </span>
                ))}
              </div>
              {t.defaultAccount && (
                <p className="text-xs text-muted-foreground mt-1">
                  Default account: {t.defaultAccount}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-rose-600 shrink-0"
              onClick={() => handleDelete(t.id)}
              disabled={deletingId === t.id}
              title="Delete template"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
