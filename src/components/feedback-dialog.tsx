"use client";

/**
 * Controlled "Send feedback" dialog. Posts to /api/feedback with the current
 * route as context. Plaintext-storage warning is shown to the user. Triggered
 * from the nav (desktop sidebar + mobile panel).
 */

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { X, Paperclip } from "lucide-react";
import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  isSafeInlineImageMime,
  validateFeedbackAttachment,
} from "@/lib/feedback/attachment";
import type { FeedbackType } from "@shared/types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const TYPES: { value: FeedbackType; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
  { value: "question", label: "Question" },
  { value: "other", label: "Other" },
];

export function FeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const pathname = usePathname();
  const [type, setType] = useState<FeedbackType>("bug");
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isImage = !!file && isSafeInlineImageMime(file.type);

  // Object-URL preview for safe images only; revoked when file changes/unmounts.
  useEffect(() => {
    if (!file || !isSafeInlineImageMime(file.type)) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const clearFile = () => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const reset = () => {
    setType("bug");
    setMessage("");
    clearFile();
    setDone(false);
    setError(null);
    setSubmitting(false);
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const f = e.target.files?.[0] ?? null;
    if (!f) {
      clearFile();
      return;
    }
    // Client-side mirror of the server guard (server is the source of truth).
    const check = validateFeedbackAttachment({
      filename: f.name,
      mime: f.type,
      size: f.size,
    });
    if ("code" in check) {
      setError(check.message);
      clearFile();
      return;
    }
    setFile(f);
  };

  const submit = async () => {
    const trimmed = message.trim();
    if (!trimmed) {
      setError("Please enter a message.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        form.append("type", type);
        form.append("message", trimmed);
        form.append("pageUrl", pathname);
        form.append("attachment", file);
        // No Content-Type header — the browser sets the multipart boundary.
        res = await fetch("/api/feedback", { method: "POST", body: form });
      } else {
        res = await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, message: trimmed, pageUrl: pathname }),
        });
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to submit feedback.");
      }
      setDone(true);
      setMessage("");
      clearFile();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit feedback.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Report a bug or suggest an improvement. Please don&apos;t include
            sensitive financial details.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="py-4 text-sm text-muted-foreground">
            Thanks! Your feedback has been sent.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <div className="flex flex-wrap gap-2">
                {TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setType(t.value)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-sm transition-colors",
                      type === t.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="feedback-message">Message</Label>
              <textarea
                id="feedback-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                maxLength={4000}
                placeholder="What happened, or what would you like to see?"
                className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Attachment (optional)</Label>
              {file && isImage && previewUrl ? (
                <div className="relative inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl}
                    alt="Attachment preview"
                    className="max-h-40 w-auto rounded-md border border-border object-contain"
                  />
                  <button
                    type="button"
                    onClick={clearFile}
                    aria-label="Remove attachment"
                    className="absolute -right-2 -top-2 rounded-full border border-border bg-background p-1 text-muted-foreground shadow-sm hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {file.name}
                  </p>
                </div>
              ) : file ? (
                <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                  <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={clearFile}
                    aria-label="Remove attachment"
                    className="shrink-0 rounded-full p-1 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Attach a file
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                onChange={onPickFile}
                className="hidden"
              />
              <p className="text-xs text-muted-foreground">
                Any file up to{" "}
                {Math.floor(FEEDBACK_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB
                (executables, scripts, and web pages are blocked). Double-check it
                doesn&apos;t reveal account numbers, balances, or other sensitive
                financial details before attaching.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {done ? (
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button onClick={submit} disabled={submitting || !message.trim()}>
                {submitting ? "Sending…" : "Send feedback"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
