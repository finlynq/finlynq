"use client";

/** Renders a guide or note (FINLYNQ-219) from parsed blocks; never injects HTML. */

import { parseMarkdown, type InlinePart } from "@/lib/guides/markdown";

function Inline({ parts }: { parts: InlinePart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "code" ? (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {p.text}
          </code>
        ) : p.kind === "bold" ? (
          <strong key={i}>{p.text}</strong>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export function MarkdownView({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const cls = b.level === 1 ? "text-lg font-semibold" : b.level === 2 ? "text-base font-semibold pt-2" : "text-sm font-semibold";
          return (
            <p key={i} className={cls}>
              <Inline parts={b.parts} />
            </p>
          );
        }
        if (b.kind === "list") {
          const ListTag = b.ordered ? "ol" : "ul";
          return (
            <ListTag key={i} className={`${b.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline parts={item} />
                </li>
              ))}
            </ListTag>
          );
        }
        if (b.kind === "code") {
          return (
            <pre key={i} className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {b.text}
            </pre>
          );
        }
        return (
          <p key={i}>
            <Inline parts={b.parts} />
          </p>
        );
      })}
    </div>
  );
}
