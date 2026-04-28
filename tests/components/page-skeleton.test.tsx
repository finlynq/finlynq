/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import { PageSkeleton } from "@/components/page-skeleton";

describe("PageSkeleton", () => {
  it("renders table variant by default", () => {
    const { container } = render(<PageSkeleton />);
    // Default is 5 rows
    const skeletonRows = container.querySelectorAll(".animate-shimmer");
    expect(skeletonRows.length).toBeGreaterThan(0);
  });

  it("renders custom number of rows", () => {
    const { container } = render(<PageSkeleton rows={3} />);
    // Should have header elements + 3 rows
    const allShimmer = container.querySelectorAll(".animate-shimmer");
    expect(allShimmer.length).toBeGreaterThanOrEqual(3);
  });

  it("renders cards variant", () => {
    const { container } = render(<PageSkeleton variant="cards" rows={4} />);
    const grid = container.querySelector(".grid");
    expect(grid).not.toBeNull();
    const cards = grid!.children;
    expect(cards).toHaveLength(4);
  });

  it("renders list variant", () => {
    const { container } = render(<PageSkeleton variant="list" rows={3} />);
    const items = container.querySelectorAll(".rounded-xl");
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it("renders table variant with border", () => {
    const { container } = render(<PageSkeleton variant="table" rows={2} />);
    const bordered = container.querySelector(".rounded-xl.border");
    expect(bordered).not.toBeNull();
  });
});
