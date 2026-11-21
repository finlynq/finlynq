"use client";

/**
 * Saved reports / saved Transactions views menu (GH #427), shared by the
 * Reports and Transactions pages. The page supplies how to turn its current
 * state into a config (`buildConfig`) and how to apply one (`onApply`); this
 * component owns the list, the Save / Rename dialogs, Save changes, Delete
 * and (Transactions only) the default view.
 *
 * Opening on load: `openViewId` (the page's `?savedView=` link) wins, else
 * the default view when `openDefault` is set. Either waits for `ready` (the
 * page's own preferences loaded) so a late preference load can't overwrite
 * the view, and runs once.
 */
import { useEffect, useRef, useState } from "react";
import { Bookmark, BookmarkPlus, ChevronDown, Pencil, Save, Star, StarOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSavedViews } from "@/lib/hooks/useSavedViews";
import { REPORT_DATE_PRESETS, REPORT_DATE_PRESET_LABELS, type ReportDatePreset } from "@/lib/reports/presets";
import { SAVED_VIEW_NAME_MAX, type SavedView, type SavedViewConfig, type SavedViewKind } from "@/lib/saved-views/config";

/**
 * How a Transactions view keeps its dates when saved: "keep" (Save changes:
 * a preset stays a preset while the dates still match it), "shown" (the
 * dates on screen), "none" (any date) or a preset key.
 */
export type SavedViewDateChoice = "keep" | "shown" | "none" | ReportDatePreset;

export interface SavedViewsMenuProps<C extends SavedViewConfig> {
  kind: SavedViewKind;
  /** Menu title, e.g. "Saved reports" or "Views". */
  title: string;
  /** What one is called in sentences: "report" or "view". */
  noun: string;
  buildConfig: (opts: { previous: C | null; dateChoice: SavedViewDateChoice }) => C;
  onApply: (config: C) => void;
  /** Offer "Open by default" (Transactions). */
  allowDefault?: boolean;
  /** Ask in the Save dialog how to keep the dates (Transactions). */
  offerDateChoice?: boolean;
  openViewId?: number | null;
  openDefault?: boolean;
  ready?: boolean;
}

export function SavedViewsMenu<C extends SavedViewConfig>({
  kind,
  title,
  noun,
  buildConfig,
  onApply,
  allowDefault = false,
  offerDateChoice = false,
  openViewId = null,
  openDefault = false,
  ready = true,
}: SavedViewsMenuProps<C>) {
  const { views, loaded, loadError, create, update, remove } = useSavedViews(kind);
  const [activeId, setActiveId] = useState<number | null>(null);
  const active = views.find((v) => v.id === activeId) ?? null;

  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flash(text: string, error = false) {
    setStatus({ text, error });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), error ? 8000 : 3000);
  }
  useEffect(() => () => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
  }, []);

  function apply(view: SavedView) {
    if (!view.config || view.unreadable) return;
    setActiveId(view.id);
    onApply(view.config as C);
  }

  // Open the linked or default view once, after the list and the page are ready.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !loaded || !ready) return;
    opened.current = true;
    const target =
      (openViewId != null ? views.find((v) => v.id === openViewId) : undefined) ??
      (openViewId == null && openDefault ? views.find((v) => v.isDefault) : undefined);
    if (target) apply(target);
    else if (openViewId != null) flash(`That saved ${noun} wasn't found.`, true);
    // apply/flash are stable enough for a one-shot effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, ready, views, openViewId, openDefault]);

  // ── Save as new ──
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDates, setSaveDates] = useState<SavedViewDateChoice>("shown");
  const [saveDefault, setSaveDefault] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  function openSave() {
    setSaveName("");
    setSaveDates("shown");
    setSaveDefault(false);
    setSaveError("");
    setSaveOpen(true);
  }

  async function submitSave() {
    if (saving) return;
    const name = saveName.trim();
    if (!name) {
      setSaveError("Give it a name.");
      return;
    }
    setSaving(true);
    setSaveError("");
    const result = await create(name, buildConfig({ previous: null, dateChoice: offerDateChoice ? saveDates : "shown" }), allowDefault && saveDefault);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    setSaveOpen(false);
    if (result.view) setActiveId(result.view.id);
    flash(`Saved "${name}".`);
  }

  // ── Rename ──
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState(false);

  async function submitRename() {
    if (!active || renaming) return;
    const name = renameName.trim();
    if (!name) {
      setRenameError("Give it a name.");
      return;
    }
    setRenaming(true);
    setRenameError("");
    const result = await update(active.id, { name });
    setRenaming(false);
    if (!result.ok) {
      setRenameError(result.error);
      return;
    }
    setRenameOpen(false);
  }

  // ── Save changes / default / delete ──
  const [busy, setBusy] = useState(false);

  async function saveChanges() {
    if (!active || busy) return;
    setBusy(true);
    const result = await update(active.id, {
      config: buildConfig({ previous: (active.config as C) ?? null, dateChoice: "keep" }),
    });
    setBusy(false);
    flash(result.ok ? `Saved changes to "${active.name}".` : result.error, !result.ok);
  }

  async function toggleDefault() {
    if (!active || busy) return;
    setBusy(true);
    const result = await update(active.id, { isDefault: !active.isDefault });
    setBusy(false);
    if (!result.ok) flash(result.error, true);
    else flash(active.isDefault ? `"${active.name}" no longer opens by default.` : `"${active.name}" now opens by default.`);
  }

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!active || deleting) return;
    setDeleting(true);
    const result = await remove(active.id);
    setDeleting(false);
    if (!result.ok) {
      flash(result.error, true);
      return;
    }
    setDeleteOpen(false);
    flash(`Deleted "${active.name}".`);
    setActiveId(null);
  }

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 max-w-64">
              <Bookmark className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{active ? active.name : title}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-64 max-h-96 overflow-y-auto">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{title}</DropdownMenuLabel>
            {!loaded && <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>}
            {loaded && loadError && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">Couldn&apos;t load them. Reload the page to try again.</div>
            )}
            {loaded && !loadError && views.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">Nothing saved yet.</div>
            )}
            {views.map((v) => (
              <DropdownMenuItem
                key={v.id}
                disabled={v.unreadable || !v.config}
                onClick={() => apply(v)}
                className={v.id === activeId ? "font-medium" : undefined}
              >
                {v.isDefault ? <Star className="h-3.5 w-3.5 text-amber-500" /> : <span className="w-3.5" />}
                <span className="truncate">
                  {v.unreadable ? "Can't be read (sign in again)" : !v.config ? `${v.name} (settings no longer valid)` : v.name}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={openSave}>
              <BookmarkPlus className="h-3.5 w-3.5" /> Save as new {noun}…
            </DropdownMenuItem>
            {active && (
              <>
                <DropdownMenuItem onClick={saveChanges} disabled={busy}>
                  <Save className="h-3.5 w-3.5" /> Save changes to &quot;{active.name}&quot;
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setRenameName(active.name);
                    setRenameError("");
                    setRenameOpen(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" /> Rename…
                </DropdownMenuItem>
                {allowDefault && (
                  <DropdownMenuItem onClick={toggleDefault} disabled={busy}>
                    {active.isDefault ? <StarOff className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
                    {active.isDefault ? "Stop opening by default" : "Open by default"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {status && (
        <span role="status" className={`text-xs ${status.error ? "text-destructive" : "text-muted-foreground"}`}>
          {status.text}
        </span>
      )}

      <Dialog open={saveOpen} onOpenChange={(o) => !saving && setSaveOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save {noun}</DialogTitle>
            <DialogDescription>
              Saves the current settings under a name. Your {noun}s are kept with your account, so they follow you to
              any browser.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitSave();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="saved-view-name">Name</Label>
              <Input
                id="saved-view-name"
                value={saveName}
                maxLength={SAVED_VIEW_NAME_MAX}
                onChange={(e) => setSaveName(e.target.value)}
                autoFocus
              />
            </div>
            {offerDateChoice && (
              <div className="space-y-1.5">
                <Label>Dates</Label>
                <Select value={saveDates} onValueChange={(v) => setSaveDates((v ?? "shown") as SavedViewDateChoice)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="shown">The dates shown now</SelectItem>
                    <SelectItem value="none">Any date</SelectItem>
                    {REPORT_DATE_PRESETS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {REPORT_DATE_PRESET_LABELS[p]} (updates over time)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {allowDefault && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} />
                Open this {noun} when the page opens
              </label>
            )}
            {saveError && <p className="text-sm text-destructive">{saveError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSaveOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={(o) => !renaming && setRenameOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename {noun}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitRename();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="saved-view-rename">Name</Label>
              <Input
                id="saved-view-rename"
                value={renameName}
                maxLength={SAVED_VIEW_NAME_MAX}
                onChange={(e) => setRenameName(e.target.value)}
                autoFocus
              />
            </div>
            {renameError && <p className="text-sm text-destructive">{renameError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameOpen(false)} disabled={renaming}>
                Cancel
              </Button>
              <Button type="submit" disabled={renaming}>
                {renaming ? "Saving…" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${noun}`}
        description={active ? `Delete "${active.name}"? Only the saved settings are removed; no transactions change.` : ""}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
      />
    </div>
  );
}
