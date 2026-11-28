/**
 * @vitest-environment jsdom
 *
 * GH #470: completing a goal asks first, through the shared ConfirmDialog in
 * its non-destructive tone (nothing is lost, the goal can be reactivated).
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { render, fireEvent, screen } from "@testing-library/react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

describe("ConfirmDialog tone", () => {
  it("is destructive by default: warning title and red confirm", () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="Delete goal" description="Gone for good." onConfirm={() => {}} />);
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm.className).toMatch(/bg-destructive/);
    expect(screen.getByText("Delete goal").className).toMatch(/text-destructive/);
  });

  it("the default tone has a plain title and a normal confirm button", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={() => {}} tone="default" title="Mark goal complete" description="Sure?" confirmLabel="Complete goal" onConfirm={onConfirm} />,
    );
    const confirm = screen.getByRole("button", { name: "Complete goal" });
    expect(confirm.className).not.toMatch(/bg-destructive/);
    expect(confirm.className).toMatch(/bg-primary/);
    expect(screen.getByText("Mark goal complete").className).not.toMatch(/text-destructive/);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("goals page asks before completing (GH #470)", () => {
  const page = readFileSync("src/app/(app)/goals/page.tsx", "utf8");

  it("the checkmark opens the confirm instead of saving", () => {
    expect(page).toMatch(/title="Mark complete"/);
    expect(page).not.toMatch(/onClick=\{\(\) => toggleStatus\(g\)\} title="Mark complete"/);
    expect(page).toMatch(/setCompleteId\(g\.id\)/);
  });

  it("the confirm saves through the same status toggle and warns below 100%", () => {
    expect(page).toMatch(/onConfirm=\{handleComplete\}/);
    expect(page).toMatch(/tone="default"/);
    expect(page).toMatch(/completingGoal\.progress < 100/);
  });
});
