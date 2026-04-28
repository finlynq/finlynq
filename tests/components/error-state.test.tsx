/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, fireEvent } from "@testing-library/react";
import { ErrorState } from "@/components/error-state";

// Mock framer-motion to avoid animation issues in test
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement("div", props, children),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
}));

describe("ErrorState", () => {
  it("renders default title and message", () => {
    const { getByText } = render(<ErrorState />);
    expect(getByText("Something went wrong")).toBeTruthy();
    expect(
      getByText("We couldn't load this data. Please try again.")
    ).toBeTruthy();
  });

  it("renders custom title and message", () => {
    const { getByText } = render(
      <ErrorState title="Network Error" message="Check your connection" />
    );
    expect(getByText("Network Error")).toBeTruthy();
    expect(getByText("Check your connection")).toBeTruthy();
  });

  it("shows retry button when onRetry provided", () => {
    const handleRetry = vi.fn();
    const { getByText } = render(<ErrorState onRetry={handleRetry} />);
    const button = getByText("Try again");
    expect(button).toBeTruthy();
  });

  it("calls onRetry when button clicked", () => {
    const handleRetry = vi.fn();
    const { getByText } = render(<ErrorState onRetry={handleRetry} />);
    fireEvent.click(getByText("Try again"));
    expect(handleRetry).toHaveBeenCalledOnce();
  });

  it("hides retry button when no onRetry", () => {
    const { queryByText } = render(<ErrorState />);
    expect(queryByText("Try again")).toBeNull();
  });
});
