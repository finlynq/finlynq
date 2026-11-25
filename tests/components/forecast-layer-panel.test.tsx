/**
 * @vitest-environment jsdom
 *
 * Forecast layer panel: switch a layer off, reorder, remove, and edit a
 * layer through its dialog (saved layers are validated by the schema).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { LayerPanel } from "@/app/(app)/forecast/_components/layer-panel";
import { baselineScenario, layerSchema } from "@/lib/forecast/config";
import type { ForecastLineDef } from "@/lib/forecast/types";

afterEach(cleanup);

const lines: ForecastLineDef[] = [
  { key: "c:1", label: "Salary", type: "income", group: "Pay" },
  { key: "c:2", label: "Groceries", type: "expense", group: "Food" },
];

describe("LayerPanel", () => {
  it("switches a layer off, moves and removes layers", () => {
    const layers = baselineScenario().layers;
    const onChange = vi.fn();
    const { getByLabelText, getAllByLabelText } = render(<LayerPanel layers={layers} lines={lines} onChange={onChange} />);

    fireEvent.click(getByLabelText("Use Budget"));
    expect(onChange.mock.calls[0][0].find((l: { id: string }) => l.id === "budget").enabled).toBe(false);

    fireEvent.click(getAllByLabelText("Move down")[0]);
    expect(onChange.mock.calls[1][0].map((l: { id: string }) => l.id)).toEqual(["inflation", "budget"]);

    fireEvent.click(getAllByLabelText("Remove layer")[1]);
    expect(onChange.mock.calls[2][0].map((l: { id: string }) => l.id)).toEqual(["budget"]);
  });

  it("edits a layer and saves a valid one", () => {
    const manual = layerSchema.parse({ id: "m1", kind: "manual", label: "Daycare", op: "add", params: { amount: 100 } });
    const onChange = vi.fn();
    const { getByLabelText, getByText } = render(<LayerPanel layers={[manual]} lines={lines} onChange={onChange} />);
    fireEvent.click(getByLabelText("Edit layer"));
    fireEvent.change(getByLabelText("Amount per month"), { target: { value: "250" } });
    fireEvent.change(getByLabelText("From month (optional)"), { target: { value: "2027-09" } });
    fireEvent.click(getByText("Save layer"));
    const saved = onChange.mock.calls[0][0][0];
    expect(saved).toMatchObject({ id: "m1", kind: "manual", op: "add", params: { amount: 250 }, from: "2027-09" });
    expect(layerSchema.safeParse(saved).success).toBe(true);
  });

  it("shows when a layer was changed by an assistant", () => {
    const l = layerSchema.parse({ id: "m1", kind: "manual", label: "From Grok", op: "set", params: { amount: 1 }, updatedBy: "assistant" });
    const { getByLabelText } = render(<LayerPanel layers={[l]} lines={lines} onChange={() => {}} />);
    expect(getByLabelText("Changed by your assistant")).toBeTruthy();
  });
});
