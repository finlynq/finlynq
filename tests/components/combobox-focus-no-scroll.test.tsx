/**
 * @vitest-environment jsdom
 *
 * GH #437: opening a Combobox inside a scroll-locked dialog jumped the page
 * behind it to the top. Two focus calls did it: React's `autoFocus` (no
 * options) and Base UI's initial focus (`preventScroll: false`), both made
 * before the popup was positioned. The search box must still take focus, but
 * only ever with `preventScroll: true`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Combobox } from "@/components/ui/combobox";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const items = [
  { value: "1", label: "Groceries" },
  { value: "2", label: "Rent" },
];

describe("Combobox search box focus", () => {
  it("focuses the search box on open without scrolling the page", async () => {
    const calls: Array<{ el: string; opts: FocusOptions | undefined }> = [];
    const orig = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, opts?: FocusOptions) {
      calls.push({ el: this.getAttribute("data-slot") ?? this.tagName, opts });
      return orig.call(this, opts);
    });

    const { getByRole } = render(
      <Combobox value="" onValueChange={() => {}} items={items} searchPlaceholder="Search categories…" />,
    );
    fireEvent.click(getByRole("combobox"));

    await waitFor(() => {
      expect(document.activeElement?.getAttribute("data-slot")).toBe("combobox-input");
    });
    // Let Base UI's queued (microtask + animation frame) focus run, if any.
    await new Promise((r) => setTimeout(r, 50));

    const inputFocus = calls.filter((c) => c.el === "combobox-input");
    expect(inputFocus.length).toBeGreaterThan(0);
    for (const c of inputFocus) expect(c.opts?.preventScroll).toBe(true);
    expect(document.activeElement?.getAttribute("data-slot")).toBe("combobox-input");
  });
});
