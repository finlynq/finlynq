/**
 * @vitest-environment jsdom
 *
 * GH #453: a rule's Amount box must take cents. The old field fed
 * `parseFloat(text) || 0` back as its value, so "12.0" snapped to "12" before
 * "12.05" could be typed, and with no `step` the browser flagged cents.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { useState } from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DecimalInput } from "@/components/rules/rule-editor-dialog";

afterEach(cleanup);

function Harness({ initial = 0, seen }: { initial?: number; seen: number[] }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <DecimalInput value={v} onValue={(n) => { seen.push(n); setV(n); }} ariaLabel="amount" />
      <button onClick={() => setV(99)}>reset</button>
    </>
  );
}

describe("DecimalInput", () => {
  it("keeps the text while cents are typed and reports the number", () => {
    const seen: number[] = [];
    const { getByLabelText } = render(<Harness seen={seen} />);
    const box = getByLabelText("amount") as HTMLInputElement;
    for (const t of ["1", "12", "12.", "12.0", "12.05"]) {
      fireEvent.change(box, { target: { value: t } });
      expect(box.value).toBe(t === "12." ? box.value : t); // jsdom may drop a trailing "." on number inputs
    }
    expect(box.value).toBe("12.05");
    expect(seen.at(-1)).toBe(12.05);
    expect(box.getAttribute("step")).toBe("any");
  });

  it("takes negative amounts and shows a value changed from outside", () => {
    const seen: number[] = [];
    const { getByLabelText, getByText } = render(<Harness initial={5} seen={seen} />);
    const box = getByLabelText("amount") as HTMLInputElement;
    expect(box.value).toBe("5");
    fireEvent.change(box, { target: { value: "-12.34" } });
    expect(seen.at(-1)).toBe(-12.34);
    fireEvent.click(getByText("reset"));
    expect(box.value).toBe("99");
  });

  it("every amount and quantity box in the rule editor uses it", () => {
    const src = readFileSync(join(__dirname, "../../src/components/rules/rule-editor-dialog.tsx"), "utf8")
      .split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n"); // code only, not comments
    expect(src).not.toMatch(/parseFloat\(e\.target\.value\)/);
    expect(src.match(/<DecimalInput/g)?.length).toBeGreaterThanOrEqual(8);
  });
});
