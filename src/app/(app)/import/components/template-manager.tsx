"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Pencil, Trash2, Check, X, BookTemplate } from "lucide-react";
import type { ImportTemplate } from "@/lib/import-templates";

interface TemplateManagerProps {
  templates: ImportTemplate[];
  onDeleted: (id: number) => void;
  onRenamed: (id: number, name: string) => void;
}

export function TemplateManager({ templates, onDeleted, onRenamed }: TemplateManagerProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [deleting, setDeleting] = useState<number | null>(null);

  const startEdit = (t: ImportTemplate) => {
    setEditingId(t.id);
    setEditName(t.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };

  const saveEdit = async (id: number) => {
    if (!editName.trim()) return;
    try {
      const res = await fetch(`/api/import/templates/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (res.ok) {
        onRenamed(id, editName.trim());
        cancelEdit();
      }
    } catch {
      // ignore
    }
  };

  const deleteTemplate = async (id: number) => {
    setDeleting(id);
    try {
      const res = await fetch(`/api/import/templates/${id}`, { method: "DELETE" });
      if (res.ok) onDeleted(id);
    } catch {
      // ignore
    } finally {
      setDeleting(null);
    }
  };

  if (templates.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <BookTemplate className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">No saved templates yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Upload a CSV and click &quot;Save as Template&quot; to get started.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Saved Templates ({templates.length})</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {templates.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3">
              {editingId === t.id ? (
                <>
                  <Input
                    className="h-7 text-sm flex-1"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveEdit(t.id);
                      if (e.key === "Escape") cancelEdit();
                    }}
                    autoFocus
                  />
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => saveEdit(t.id)}>
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={cancelEdit}>
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.fileHeaders.length} headers
                      {t.defaultAccount && <> · {t.defaultAccount}</>}
                      {t.isDefault && <> · <Badge variant="secondary" className="text-[10px] px-1 py-0">default</Badge></>}
                    </p>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(t)}>
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => deleteTemplate(t.id)}
                    disabled={deleting === t.id}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
