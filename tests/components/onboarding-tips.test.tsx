/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, fireEvent } from "@testing-library/react";

// Mock framer-motion
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement("div", props, children),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
}));

// Mock Next.js Link
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.PropsWithChildren<{ href: string }>) =>
    React.createElement("a", { href, ...props }, children),
}));

import { OnboardingTips } from "@/components/onboarding-tips";

describe("OnboardingTips", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  it("renders dashboard tips", () => {
    const { getByText } = render(<OnboardingTips page="dashboard" />);
    expect(getByText("This is your financial overview")).toBeTruthy();
    expect(getByText("Import your bank statements")).toBeTruthy();
  });

  it("renders transaction tips", () => {
    const { getByText } = render(<OnboardingTips page="transactions" />);
    expect(getByText("Find any transaction")).toBeTruthy();
    expect(getByText("Categorize for better insights")).toBeTruthy();
  });

  it("renders budget tips", () => {
    const { getByText } = render(<OnboardingTips page="budgets" />);
    expect(getByText("Set monthly spending limits")).toBeTruthy();
  });

  it("renders import tips", () => {
    const { getByText } = render(<OnboardingTips page="import" />);
    expect(getByText("Multiple formats supported")).toBeTruthy();
  });

  it("shows Dismiss all button", () => {
    const { getByText } = render(<OnboardingTips page="dashboard" />);
    expect(getByText("Dismiss all")).toBeTruthy();
  });

  it("dismiss all hides all tips", () => {
    const { getByText, queryByText } = render(
      <OnboardingTips page="dashboard" />
    );
    fireEvent.click(getByText("Dismiss all"));
    expect(queryByText("This is your financial overview")).toBeNull();
    expect(queryByText("Import your bank statements")).toBeNull();
  });

  it("persists dismissed tips to localStorage", () => {
    const { getByText } = render(<OnboardingTips page="dashboard" />);
    fireEvent.click(getByText("Dismiss all"));
    const stored = JSON.parse(
      localStorage.getItem("pf-dismissed-tips") || "[]"
    );
    expect(stored).toContain("dash-overview");
    expect(stored).toContain("dash-import");
  });

  it("renders action links for tips that have them", () => {
    const { getByText } = render(<OnboardingTips page="dashboard" />);
    const link = getByText("View accounts");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/accounts");
  });

  it("hides tips that were previously dismissed", () => {
    localStorage.setItem(
      "pf-dismissed-tips",
      JSON.stringify(["dash-overview", "dash-import"])
    );
    const { container } = render(<OnboardingTips page="dashboard" />);
    // All dashboard tips dismissed — component should return null
    expect(container.innerHTML).toBe("");
  });
});
