"use client";

/**
 * /admin/announcements — admin authoring surface for broadcast announcements.
 * Create / edit / publish-toggle / delete. Gated server-side by requireAdmin;
 * the nav also hides this link for non-admins.
 */

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Megaphone, Pencil, Trash2, Plus } from "lucide-react";

interface AdminAnnouncement {
  id: number;
  title: string;
  body: string;
  category: string;
  severity: string;
  pinned: boolean;
  published: boolean;
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const CATEGORIES = ["news", "update", "maintenance"];
const SEVERITIES = ["info", "warning"];

function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMPTY = {
  title: "",
  body: "",
  category: "news",
  severity: "info",
  pinned: false,
  published: false,
  expiresAt: "",
};

export default function AdminAnnouncementsPage() {
  const [items, setItems] = useState<AdminAnnouncement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/announcements");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startNew = () => {
    setEditingId(null);
    setForm({ ...EMPTY });
  };

  const startEdit = (a: AdminAnnouncement) => {
    setEditingId(a.id);
    setForm({
      title: a.title,
      body: a.body,
      category: a.category,
      severity: a.severity,
      pinned: a.pinned,
      published: a.published,
      expiresAt: toLocalInputValue(a.expiresAt),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    if (!form.title.trim() || !form.body.trim()) {
      setError("Title and body are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        title: form.title.trim(),
        body: form.body.trim(),
        category: form.category,
        severity: form.severity,
        pinned: form.pinned,
        published: form.published,
        expiresAt: form.expiresAt || null,
      };
      const res = editingId
        ? await fetch(`/api/admin/announcements/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/announcements", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      startNew();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const togglePublish = async (a: AdminAnnouncement) => {
    await fetch(`/api/admin/announcements/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ published: !a.published }),
    });
    load();
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this announcement? This cannot be undone.")) return;
    await fetch(`/api/admin/announcements/${id}`, { method: "DELETE" });
    if (editingId === id) startNew();
    load();
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-2">
        <Megaphone className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">Announcements</h1>
      </div>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {/* Create / edit form */}
      <Card className="mb-8 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">
            {editingId ? `Editing #${editingId}` : "New announcement"}
          </h2>
          {editingId && (
            <Button variant="ghost" size="sm" onClick={startNew}>
              <Plus className="h-3.5 w-3.5" /> New
            </Button>
          )}
        </div>

        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="a-title">Title</Label>
            <Input
              id="a-title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              maxLength={200}
              placeholder="e.g. New: portfolio realized gains in your base currency"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="a-body">Body</Label>
            <textarea
              id="a-body"
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              rows={5}
              maxLength={10000}
              placeholder="What changed and why it matters."
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="a-category">Category</Label>
              <select
                id="a-category"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-severity">Severity</Label>
              <select
                id="a-severity"
                value={form.severity}
                onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="a-expires">Expires (optional)</Label>
            <Input
              id="a-expires"
              type="datetime-local"
              value={form.expiresAt}
              onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.pinned}
                onChange={(e) => setForm((f) => ({ ...f, pinned: e.target.checked }))}
              />
              Pinned (shows as banner)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.published}
                onChange={(e) => setForm((f) => ({ ...f, published: e.target.checked }))}
              />
              Published
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Create"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Existing announcements */}
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        All announcements
      </h2>
      {items && items.length === 0 && (
        <p className="text-sm text-muted-foreground">None yet.</p>
      )}
      <div className="space-y-2">
        {items?.map((a) => (
          <Card key={a.id} className="p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.title}</span>
                  {a.published ? (
                    <Badge className="bg-emerald-500/15 text-emerald-500">Published</Badge>
                  ) : (
                    <Badge variant="outline">Draft</Badge>
                  )}
                  {a.pinned && <Badge variant="secondary">Pinned</Badge>}
                  <Badge variant="outline" className="capitalize">
                    {a.category}
                  </Badge>
                  {a.severity === "warning" && (
                    <Badge className="bg-amber-500/15 text-amber-500">Warning</Badge>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{a.body}</p>
                {a.expiresAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Expires {new Date(a.expiresAt).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="outline" size="sm" onClick={() => togglePublish(a)}>
                  {a.published ? "Unpublish" : "Publish"}
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => startEdit(a)} aria-label="Edit">
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(a.id)}
                  aria-label="Delete"
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
