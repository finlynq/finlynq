/**
 * @vitest-environment jsdom
 *
 * The Payee field suggests payees already used; picking one reports it to
 * the caller, and each suggestion can be taken out of the list.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React, { useState } from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { PayeeInput } from "@/components/ui/payee-input";
import { clearPayeeOptionsCache } from "@/lib/hooks/usePayeeOptions";
import type { PayeeOption } from "@/lib/payees/suggest";

const PAYEES: PayeeOption[] = [
  { id: 1, name: "Corner Cafe", count: 9, categoryId: 4 },
  { id: 2, name: "Costco", count: 20, categoryId: 5 },
];

let calls: Array<{ url: string; method: string; body?: string }> = [];

beforeEach(() => {
  calls = [];
  clearPayeeOptionsCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      return { ok: true, json: async () => ({ success: true, data: { payees: PAYEES, locked: false } }) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ initial = "", onPick }: { initial?: string; onPick?: (p: PayeeOption) => void }) {
  const [v, setV] = useState(initial);
  return <PayeeInput value={v} onValueChange={setV} onPick={onPick ? (p) => { setV(p.name); onPick(p); } : undefined} />;
}
const box = (c: HTMLElement) => c.querySelector('input[role="combobox"]') as HTMLInputElement;

describe("PayeeInput", () => {
  it("does not fetch or suggest until the field is used", () => {
    const { container, queryByRole } = render(<Harness initial="Costco" />);
    expect(calls).toHaveLength(0);
    fireEvent.focus(box(container));
    expect(queryByRole("listbox")).toBeNull();
  });

  it("suggests as you type, most used first, and picks with the keyboard", async () => {
    const picked: PayeeOption[] = [];
    const { container, findByRole, queryByRole } = render(<Harness onPick={(p) => picked.push(p)} />);
    const input = box(container);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "co" } });
    const list = await findByRole("listbox");
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Costco20", "Corner Cafe9"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(picked).toEqual([PAYEES[0]]);
    expect(input.value).toBe("Corner Cafe");
    expect(queryByRole("listbox")).toBeNull();
  });

  it("a new payee is just typed text", async () => {
    const { container } = render(<Harness />);
    const input = box(container);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Brand New Shop" } });
    expect(input.value).toBe("Brand New Shop");
  });

  it("the small button takes a payee out of the suggestions", async () => {
    const { container, findByRole, findByLabelText } = render(<Harness />);
    const input = box(container);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "co" } });
    await findByRole("listbox");
    fireEvent.mouseDown(await findByLabelText("Stop suggesting Costco"));
    const list = await findByRole("listbox");
    expect(list.textContent).not.toContain("Costco");
    expect(calls.some((c) => c.method === "DELETE" && c.body === JSON.stringify({ id: 2 }))).toBe(true);
    expect(input.value).toBe("co");
  });
});
