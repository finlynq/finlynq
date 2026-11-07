/**
 * @vitest-environment jsdom
 *
 * The Reports date field passes on a date only once it is finished
 * (2026-11-07). A browser date input reports every keystroke of the year, and
 * each half-typed year (0002, 0020, 0201) used to run the whole report.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React, { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ReportDateInput } from "@/app/(app)/reports/_components/report-date-input";

afterEach(() => cleanup());

function field() {
  return screen.getByLabelText("Start date") as HTMLInputElement;
}

describe("ReportDateInput", () => {
  it("commits only the finished year while typing 2010", () => {
    const onCommit = vi.fn();
    render(<ReportDateInput value="2026-01-01" onCommit={onCommit} aria-label="Start date" />);
    for (const v of ["0002-01-01", "0020-01-01", "0201-01-01", "2010-01-01"]) {
      fireEvent.change(field(), { target: { value: v } });
    }
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("2010-01-01");
  });

  it("puts the last committed date back when left unfinished", () => {
    const onCommit = vi.fn();
    render(<ReportDateInput value="2026-01-01" onCommit={onCommit} aria-label="Start date" />);
    fireEvent.change(field(), { target: { value: "0020-01-01" } });
    expect(field().value).toBe("0020-01-01"); // typing is not fought mid-way
    fireEvent.blur(field());
    expect(field().value).toBe("2026-01-01");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not commit a cleared field", () => {
    const onCommit = vi.fn();
    render(<ReportDateInput value="2026-01-01" onCommit={onCommit} aria-label="Start date" />);
    fireEvent.change(field(), { target: { value: "" } });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows a new value set from outside (a preset)", () => {
    function Host() {
      const [d, setD] = useState("2026-01-01");
      return (
        <>
          <ReportDateInput value={d} onCommit={setD} aria-label="Start date" />
          <button onClick={() => setD("1970-01-01")}>All time</button>
        </>
      );
    }
    render(<Host />);
    fireEvent.change(field(), { target: { value: "0201-01-01" } });
    fireEvent.click(screen.getByText("All time"));
    expect(field().value).toBe("1970-01-01");
  });
});
