/**
 * @vitest-environment jsdom
 *
 * GH #449: the tag field shows finished tags as chips and suggests existing
 * tags, while its value stays one comma-separated string.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React, { useState } from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TagInput } from "@/components/ui/tag-input";
import { clearTagOptionsCache } from "@/lib/hooks/useTagOptions";

const TAGS = [
  { tag: "Vacation", count: 12 },
  { tag: "work", count: 30 },
];

beforeEach(() => {
  clearTagOptionsCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { tags: TAGS, locked: false } }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ initial = "", onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <TagInput
      value={v}
      onValueChange={(next) => {
        setV(next);
        onChange?.(next);
      }}
      placeholder="tags"
    />
  );
}

const chipsOf = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-slot="tag-chip"]')].map((el) => el.textContent);
const box = (c: HTMLElement) => c.querySelector('input[role="combobox"]') as HTMLInputElement;

describe("TagInput", () => {
  it("shows a saved value as chips with an empty box", () => {
    const { container } = render(<Harness initial="work, Vacation" />);
    expect(chipsOf(container)).toEqual(["work", "Vacation"]);
    expect(box(container).value).toBe("");
  });

  it("a comma finishes the tag; the value stays a comma-separated string", () => {
    const seen: string[] = [];
    const { container } = render(<Harness onChange={(v) => seen.push(v)} />);
    const input = box(container);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "gro" } });
    expect(seen.at(-1)).toBe("gro");
    expect(chipsOf(container)).toEqual([]);
    fireEvent.change(input, { target: { value: "groceries," } });
    expect(seen.at(-1)).toBe("groceries");
    expect(chipsOf(container)).toEqual(["groceries"]);
    expect(input.value).toBe("");
  });

  it("Enter finishes the tag being typed and leaving the field does too", () => {
    const seen: string[] = [];
    const { container } = render(<Harness initial="work" onChange={(v) => seen.push(v)} />);
    const input = box(container);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "trip" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(chipsOf(container)).toEqual(["work", "trip"]);
    fireEvent.change(input, { target: { value: "beach" } });
    expect(seen.at(-1)).toBe("work, trip, beach");
    fireEvent.blur(input);
    expect(chipsOf(container)).toEqual(["work", "trip", "beach"]);
  });

  it("pasting several tags makes several chips", () => {
    const seen: string[] = [];
    const { container } = render(<Harness onChange={(v) => seen.push(v)} />);
    fireEvent.change(box(container), { target: { value: "a, b ,c" } });
    expect(chipsOf(container)).toEqual(["a", "b"]);
    expect(seen.at(-1)).toBe("a, b, c");
  });

  it("the chip button and Backspace in an empty box remove tags", () => {
    const seen: string[] = [];
    const { container, getByLabelText } = render(<Harness initial="a, b, c" onChange={(v) => seen.push(v)} />);
    fireEvent.click(getByLabelText("Remove tag b"));
    expect(seen.at(-1)).toBe("a, c");
    fireEvent.keyDown(box(container), { key: "Backspace" });
    expect(seen.at(-1)).toBe("a");
    expect(chipsOf(container)).toEqual(["a"]);
  });

  it("suggests existing tags and picks one with the arrow keys", async () => {
    const seen: string[] = [];
    const { container, findByRole } = render(<Harness initial="work" onChange={(v) => seen.push(v)} />);
    const input = box(container);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "vac" } });
    const list = await findByRole("listbox");
    expect(list.textContent).toContain("Vacation");
    expect(list.textContent).not.toContain("work");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(seen.at(-1)).toBe("work, Vacation");
    expect(chipsOf(container)).toEqual(["work", "Vacation"]);
  });

  it("notes a finished new tag that is close to an existing one", async () => {
    const { container } = render(<Harness />);
    const input = box(container);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Vacations," } });
    await waitFor(() => expect(container.textContent).toContain("is close to your tag"));
  });

  it("drops the tag in progress when the value is replaced from outside", () => {
    function Outer() {
      const [v, setV] = useState("");
      return (
        <>
          <TagInput value={v} onValueChange={setV} />
          <button onClick={() => setV("x, y")}>reset</button>
        </>
      );
    }
    const { container, getByText } = render(<Outer />);
    fireEvent.change(box(container), { target: { value: "half" } });
    fireEvent.click(getByText("reset"));
    expect(chipsOf(container)).toEqual(["x", "y"]);
    expect(box(container).value).toBe("");
  });
});
