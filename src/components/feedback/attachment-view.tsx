"use client";

/**
 * Render a feedback attachment inside a thread bubble (FINLYNQ-228) — a safe
 * inline image thumbnail, or a download chip for any other file type. Used by
 * BOTH the user thread (/feedback) and the admin thread (/admin/feedback); the
 * caller passes the appropriate owner-scoped vs admin-gated serve `url`.
 */

import { Paperclip } from "lucide-react";
import { isSafeInlineImageMime } from "@/lib/feedback/attachment";
import type { FeedbackAttachmentMeta } from "@shared/types";

export function FeedbackAttachmentView({
  attachment,
  url,
  align = "left",
}: {
  attachment: FeedbackAttachmentMeta;
  /** Serve route for these bytes (seed or `?messageId=`). */
  url: string;
  align?: "left" | "right";
}) {
  const name = attachment.filename ?? "attachment";
  const isImage = isSafeInlineImageMime(attachment.mime);

  if (isImage) {
    return (
      <div className={align === "right" ? "flex flex-col items-end" : "flex flex-col items-start"}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block max-w-[85%] overflow-hidden rounded-lg border border-border"
          title={name}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={name} className="max-h-64 w-auto object-contain" />
        </a>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          download={name}
          className="mt-1 text-[10px] text-primary underline-offset-2 hover:underline"
        >
          {name}
        </a>
      </div>
    );
  }

  return (
    <div className={align === "right" ? "flex justify-end" : "flex justify-start"}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        download={name}
        className="inline-flex max-w-[85%] items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
        title={name}
      >
        <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{name}</span>
      </a>
    </div>
  );
}
