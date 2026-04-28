/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, fireEvent } from "@testing-library/react";

// Mock next-themes
const mockSetTheme = vi.fn();
let mockTheme = "light";

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: mockTheme,
    setTheme: mockSetTheme,
  }),
}));

// Mock framer-motion
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement("div", props, children),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
}));

import { ThemeToggle } from "@/components/theme-toggle";

describe("ThemeToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTheme = "light";
  });

  it("renders a button with aria-label", () => {
    const { getByLabelText } = render(<ThemeToggle />);
    expect(getByLabelText("Toggle theme")).toBeTruthy();
  });

  it("toggles from light to dark on click", () => {
    const { getByLabelText } = render(<ThemeToggle />);
    fireEvent.click(getByLabelText("Toggle theme"));
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("toggles from dark to light on click", () => {
    mockTheme = "dark";
    const { getByLabelText } = render(<ThemeToggle />);
    fireEvent.click(getByLabelText("Toggle theme"));
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });
});
