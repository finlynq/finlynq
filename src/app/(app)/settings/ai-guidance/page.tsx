"use client";

/**
 * /settings/ai-guidance — the AI guidance library (FINLYNQ-219).
 *
 *   Your notes      the user's own notes, which an AI assistant reads at the
 *                   start of a session (MCP `get_guidance`) and may save
 *                   (`manage_guidance_notes`). The user sees, edits, adds and
 *                   retires them here; every save is version-checked so the
 *                   user and the assistant can't overwrite each other.
 *   Finlynq guides  the general guide modules (src/lib/guides), read-only.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MarkdownView } from "@/components/guidance/markdown-view";
import { parseSaveError } from "@/lib/save-error";
import { GUIDE_MODULES } from "@/lib/guides/registry";
import { checkNote, NOTE_MAX_TOKENS } from "@/lib/guides/notes-rules";
import { estimateTokens } from "@/lib/guides/registry";
import { Bot, BookOpen, History, NotebookPen, Plus, User } from "lucide-react";

interface NoteSummary {
  id: number;
  path: string;
  title: string;
  summary: string | null;
  version: number;
  updatedBy: "user" | "assistant";
  updatedAt: string;
}
interface NoteFull extends NoteSummary {
  body: string;
}
interface NoteRevision {
  version: number;
  action: "save" | "retire";
  title: string;
  body: string;
  updatedBy: "user" | "assistant";
  createdAt: string;
}

type Draft = { path: string; title: string; summary: string; body: string; expectedVersion: number; isNew: boolean };

function who(by: "user" | "assistant") {
  return by === "assistant" ? "your assistant" : "you";
}

function when(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

const TEXTAREA =
  "min-h-[240px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export default function AiGuidanceSettingsPage() {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<NoteFull | null>(null);
  const [history, setHistory] = useState<NoteRevision[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [retireOpen, setRetireOpen] = useState(false);
  const [openGuide, setOpenGuide] = useState<string | null>(null);

  const loadNotes = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/guidance/notes");
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Couldn't load your notes.");
      setLocked(!!json.data?.locked);
      setNotes(json.data?.notes ?? null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load your notes.");
    }
  }, []);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  async function openNote(id: number) {
    setDraft(null);
    setFormError("");
    setShowHistory(false);
    const res = await fetch(`/api/guidance/notes/${id}`);
    if (!res.ok) {
      setFormError(await parseSaveError(res, "Couldn't open that note."));
      return;
    }
    const json = await res.json();
    setSelected(json.data.note);
    setHistory(json.data.history);
  }

  function startNew() {
    setSelected(null);
    setHistory(null);
    setFormError("");
    setDraft({ path: "", title: "", summary: "", body: "", expectedVersion: 0, isNew: true });
  }

  function startEdit(n: NoteFull) {
    setFormError("");
    setDraft({ path: n.path, title: n.title, summary: n.summary ?? "", body: n.body, expectedVersion: n.version, isNew: false });
  }

  async function save() {
    if (!draft || saving) return;
    const checked = checkNote(draft);
    if (!checked.ok) {
      setFormError(checked.error);
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/guidance/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...checked.note, expectedVersion: draft.expectedVersion }),
      });
      if (!res.ok) {
        // Keep the form open with the user's text; a 409 says someone saved in between.
        setFormError(await parseSaveError(res, "Couldn't save the note."));
        return;
      }
      const json = await res.json();
      setDraft(null);
      await loadNotes();
      await openNote(json.data.note.id);
    } catch {
      setFormError("Couldn't reach Finlynq. Your text is still here; try again.");
    } finally {
      setSaving(false);
    }
  }

  async function retire() {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/guidance/notes/${selected.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: selected.version }),
      });
      if (!res.ok) {
        setFormError(await parseSaveError(res, "Couldn't retire the note."));
        return;
      }
      setSelected(null);
      setHistory(null);
      await loadNotes();
    } catch {
      setFormError("Couldn't reach Finlynq. Try again.");
    } finally {
      setSaving(false);
      setRetireOpen(false);
    }
  }

  const bodyTokens = draft ? estimateTokens(draft.body) : 0;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">AI guidance</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          What an AI assistant connected to Finlynq reads before it starts: Finlynq&apos;s own guides, and notes about your
          money that you or your assistant saved.
        </p>
      </div>

      <Tabs defaultValue="notes" className="w-full">
        <TabsList>
          <TabsTrigger value="notes">
            <NotebookPen className="mr-1.5 h-4 w-4" /> Your notes
          </TabsTrigger>
          <TabsTrigger value="guides">
            <BookOpen className="mr-1.5 h-4 w-4" /> Finlynq guides
          </TabsTrigger>
        </TabsList>

        <TabsContent value="notes" className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Notes are facts that save your assistant work, like a bank whose file has its signs reversed or a payee that
            always means one category. They are information, not permission: your assistant still asks before acting.
            Never put passwords, keys or account numbers in a note.
          </p>

          {loadError && <p className="text-sm text-destructive">{loadError}</p>}
          {locked && (
            <Card>
              <CardContent className="py-6 text-sm">
                Your notes are encrypted and this session is locked. Sign in again to see and edit them.
              </CardContent>
            </Card>
          )}

          {!locked && notes && (
            <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-base">Notes ({notes.length})</CardTitle>
                  <Button size="sm" onClick={startNew}>
                    <Plus className="mr-1 h-4 w-4" /> New note
                  </Button>
                </CardHeader>
                <CardContent className="space-y-1">
                  {notes.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No notes yet. Your assistant can add them as it learns, or you can write one.
                    </p>
                  )}
                  {notes.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => openNote(n.id)}
                      className={`w-full rounded-md px-2 py-2 text-left hover:bg-muted ${selected?.id === n.id ? "bg-muted" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{n.title}</span>
                        {n.updatedBy === "assistant" && (
                          <Badge variant="secondary" className="shrink-0">
                            <Bot className="mr-1 h-3 w-3" /> assistant
                          </Badge>
                        )}
                      </div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{n.path}</div>
                      {n.summary && <div className="truncate text-xs text-muted-foreground">{n.summary}</div>}
                    </button>
                  ))}
                </CardContent>
              </Card>

              <Card>
                {draft ? (
                  <>
                    <CardHeader>
                      <CardTitle className="text-base">{draft.isNew ? "New note" : `Edit ${draft.path}`}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {draft.isNew && (
                        <div className="space-y-1">
                          <Label htmlFor="note-path">File name</Label>
                          <Input
                            id="note-path"
                            placeholder="banks/rbc-chequing.md"
                            value={draft.path}
                            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                          />
                        </div>
                      )}
                      <div className="space-y-1">
                        <Label htmlFor="note-title">Title</Label>
                        <Input id="note-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="note-summary">One-line summary (optional)</Label>
                        <Input
                          id="note-summary"
                          value={draft.summary}
                          onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="note-body">Note (Markdown)</Label>
                        <textarea
                          id="note-body"
                          className={TEXTAREA}
                          value={draft.body}
                          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                        />
                        <p className={`text-xs ${bodyTokens > NOTE_MAX_TOKENS ? "text-destructive" : "text-muted-foreground"}`}>
                          About {bodyTokens} of {NOTE_MAX_TOKENS} tokens
                        </p>
                      </div>
                      {formError && <p className="text-sm text-destructive">{formError}</p>}
                      <div className="flex gap-2">
                        <Button onClick={save} disabled={saving}>
                          {saving ? "Saving…" : "Save"}
                        </Button>
                        <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
                          Cancel
                        </Button>
                      </div>
                    </CardContent>
                  </>
                ) : selected ? (
                  <>
                    <CardHeader>
                      <CardTitle className="text-base">{selected.title}</CardTitle>
                      <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono">{selected.path}</span>
                        <span>· version {selected.version}</span>
                        <span className="inline-flex items-center gap-1">
                          · {selected.updatedBy === "assistant" ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
                          changed by {who(selected.updatedBy)}, {when(selected.updatedAt)}
                        </span>
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <MarkdownView markdown={selected.body} />
                      {formError && <p className="text-sm text-destructive">{formError}</p>}
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => startEdit(selected)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setShowHistory((v) => !v)}>
                          <History className="mr-1 h-4 w-4" /> {showHistory ? "Hide history" : "History"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRetireOpen(true)}>
                          Retire
                        </Button>
                      </div>
                      {showHistory && history && (
                        <div className="space-y-2 border-t pt-3">
                          {history.map((h) => (
                            <details key={`${h.version}-${h.action}-${h.createdAt}`} className="rounded-md border px-3 py-2">
                              <summary className="cursor-pointer text-sm">
                                Version {h.version} · {h.action === "retire" ? "retired" : "saved"} by {who(h.updatedBy)},{" "}
                                {when(h.createdAt)}
                              </summary>
                              <div className="pt-2">
                                <MarkdownView markdown={h.body} />
                              </div>
                            </details>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </>
                ) : (
                  <CardContent className="py-10 text-center text-sm text-muted-foreground">
                    {formError || "Pick a note to read it, or write a new one."}
                  </CardContent>
                )}
              </Card>
            </div>
          )}
        </TabsContent>

        <TabsContent value="guides" className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Finlynq&apos;s guides for each area. Your assistant reads them when a task needs them. They come with the app
            and can&apos;t be edited here.
          </p>
          {GUIDE_MODULES.map((m) => (
            <Card key={m.id}>
              <CardHeader className="cursor-pointer" onClick={() => setOpenGuide(openGuide === m.id ? null : m.id)}>
                <CardTitle className="text-base">{m.title}</CardTitle>
                <CardDescription>{m.summary}</CardDescription>
              </CardHeader>
              {openGuide === m.id && (
                <CardContent>
                  <MarkdownView markdown={m.markdown} />
                </CardContent>
              )}
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={retireOpen}
        onOpenChange={setRetireOpen}
        title="Retire this note?"
        description="Your assistant will stop reading it. Its history is kept."
        confirmLabel="Retire"
        onConfirm={retire}
        busy={saving}
      />
    </div>
  );
}
