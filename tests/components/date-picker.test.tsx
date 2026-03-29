/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, fireEvent } from "@testing-library/react";
import { DatePicker } from "@/components/date-picker";

describe("DatePicker", () => {
  it("renders an input with type=date", () => {
    const { container } = render(
      <DatePicker value="2026-03-29" onChange={() => {}} />
    );
    const input = container.querySelector('input[type="date"]');
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe("2026-03-29");
  });

  it("calls onChange when value changes", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <DatePicker value="2026-03-29" onChange={handleChange} />
    );
    const input = container.querySelector('input[type="date"]')!;
    fireEvent.change(input, { target: { value: "2026-04-01" } });
    expect(handleChange).toHaveBeenCalledWith("2026-04-01");
  });

  it("renders label when provided", () => {
    const { getByText } = render(
      <DatePicker value="" onChange={() => {}} label="Start Date" />
    );
    expect(getByText("Start Date")).toBeTruthy();
  });

  it("does not render label when not provided", () => {
    const { container } = render(
      <DatePicker value="" onChange={() => {}} />
    );
    const labels = container.querySelectorAll("label");
    expect(labels).toHaveLength(0);
  });

  it("shows error message when error provided", () => {
    const { getByText } = render(
      <DatePicker value="" onChange={() => {}} error="Required field" />
    );
    expect(getByText("Required field")).toBeTruthy();
  });

  it("applies error styling to input", () => {
    const { container } = render(
      <DatePicker value="" onChange={() => {}} error="Invalid" />
    );
    const input = container.querySelector("input")!;
    expect(input.className).toContain("destructive");
  });

  it("sets min and max attributes", () => {
    const { container } = render(
      <DatePicker
        value="2026-03-15"
        onChange={() => {}}
        min="2026-01-01"
        max="2026-12-31"
      />
    );
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.min).toBe("2026-01-01");
    expect(input.max).toBe("2026-12-31");
  });
});
