// AI guidance Markdown reader (FINLYNQ-219). A MIRROR of the web's
// src/lib/guides/markdown.ts: keep the two in sync. Pure.
//
// Guides and notes are short and plain: headings, paragraphs, bullet and
// numbered lists, fenced code, inline `code` and **bold**. The screens render
// these blocks as Text, so a note is never treated as markup.

export type InlinePart = { kind: "text" | "code" | "bold"; text: string };

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; parts: InlinePart[] }
  | { kind: "paragraph"; parts: InlinePart[] }
  | { kind: "list"; ordered: boolean; items: InlinePart[][] }
  | { kind: "code"; text: string };

export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) parts.push({ kind: "text", text: text.slice(last, i) });
    const tok = m[0];
    parts.push(tok.startsWith("`") ? { kind: "code", text: tok.slice(1, -1) } : { kind: "bold", text: tok.slice(2, -2) });
    last = i + tok.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

export function parseMarkdown(src: string): MarkdownBlock[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "paragraph", parts: parseInline(para.join(" ")) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      flushPara();
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i++]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ kind: "heading", level: h[1].length as 1 | 2 | 3, parts: parseInline(h[2].trim()) });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flushPara();
      const ordered = !!n;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((b ?? n)![1].trim());
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // A wrapped continuation of the last list item.
      list.items[list.items.length - 1] += " " + line.trim();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}
