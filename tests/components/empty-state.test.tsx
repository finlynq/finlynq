/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, fireEvent } from "@testing-library/react";
import { EmptyState } from "@/components/empty-state";
import { FileText } from "lucide-react";

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

describe("EmptyState", () => {
  it("renders title and description", () => {
    const { getByText } = render(
      <EmptyState
        icon={FileText}
        title="No transactions"
        description="Add your first transaction to get started"
      />
    );
    expect(getByText("No transactions")).toBeTruthy();
    expect(getByText("Add your first transaction to get started")).toBeTruthy();
  });

  it("renders link action when href provided", () => {
    const { getByText } = render(
      <EmptyState
        icon={FileText}
        title="No data"
        description="Import your data"
        action={{ label: "Import", href: "/import" }}
      />
    );
    const link = getByText("Import");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/import");
  });

  it("renders button action when onClick provided", () => {
    const handleClick = vi.fn();
    const { getByText } = render(
      <EmptyState
        icon={FileText}
        title="Empty"
        description="Click to add"
        action={{ label: "Add Item", onClick: handleClick }}
      />
    );
    const button = getByText("Add Item");
    expect(button.tagName).toBe("BUTTON");
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it("renders without action", () => {
    const { container } = render(
      <EmptyState
        icon={FileText}
        title="Empty"
        description="Nothing here"
      />
    );
    const buttons = container.querySelectorAll("button");
    const links = container.querySelectorAll("a");
    expect(buttons).toHaveLength(0);
    expect(links).toHaveLength(0);
  });

  it("renders the icon", () => {
    const { container } = render(
      <EmptyState icon={FileText} title="Test" description="Test desc" />
    );
    // Lucide icons render as SVG
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });
});
