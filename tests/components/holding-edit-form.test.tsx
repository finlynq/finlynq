/**
 * @vitest-environment jsdom
 */
/**
 * Drift test for the shared <HoldingEditForm>.
 *
 * Issue #100: both /portfolio and /settings/investments mount the SAME
 * component, so this test asserts the field set rendered in each mode.
 * If a field gets added on one surface and not propagated, this catches
 * it because there's only one component to test.
 *
 * Also asserts the canonical-row UX: when symbol = "VCN.TO", the Name
 * input is disabled and the helper hint copy is rendered. Mirrors the
 * server-side `isCanonicalHolding()` check in the API route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { HoldingEditForm } from "@/components/holdings/holding-edit-form";

// Mock the shadcn Select primitive — base-ui Select needs a portal +
// listbox that jsdom doesn't render predictably. We swap it for a plain
// <select> that the test can drive with a change event.
vi.mock("@/components/ui/select", () => {
  type SelectProps = {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  };
  // Track items via React.Children traversal so the <option>s come from
  // the SelectItem children inside the test JSX.
  function flattenItems(children: React.ReactNode): React.ReactElement[] {
    const out: React.ReactElement[] = [];
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return;
      const props = (child as { props?: { __isSelectItem?: boolean; children?: React.ReactNode } })
        .props;
      if (props?.__isSelectItem) {
        out.push(child as React.ReactElement);
      } else if (props?.children) {
        out.push(...flattenItems(props.children));
      }
    });
    return out;
  }
  return {
    Select: ({ value, onValueChange, children }: SelectProps) => {
      const items = flattenItems(children);
      return React.createElement(
        "select",
        {
          "data-testid": "select",
          value: value ?? "",
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
            onValueChange?.(e.target.value),
        },
        items.map((item) => {
          const itemProps = (item as { props: { value: string; children: React.ReactNode } })
            .props;
          return React.createElement(
            "option",
            { key: itemProps.value, value: itemProps.value },
            typeof itemProps.children === "string" ? itemProps.children : itemProps.value,
          );
        }),
      );
    },
    SelectTrigger: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    SelectValue: ({ placeholder }: { placeholder?: string }) =>
      React.createElement("span", null, placeholder ?? ""),
    SelectContent: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => {
      // Tag the element so flattenItems can pick it up regardless of nesting.
      return React.createElement(
        "option",
        { value, __isSelectItem: true },
        children,
      );
    },
  };
});

// Mock framer-motion / next-link safely — neither is used by the form,
// but other components in the import graph may pull them.
vi.mock("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get: () => ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement("div", rest, children),
    },
  ),
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // Default: /api/accounts returns a single account. /api/portfolio/symbol-info
  // is intercepted on a per-test basis when needed.
  fetchMock.mockImplementation((url: string) => {
    if (url === "/api/accounts") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ id: 1, name: "RRSP", currency: "CAD" }]),
      });
    }
    if (url.startsWith("/api/portfolio/symbol-info")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ kind: "etf", currency: "CAD", label: "Test ETF", source: "yahoo" }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("<HoldingEditForm>", () => {
  it("renders all required fields in CREATE mode", async () => {
    const { container, getByText } = render(
      <HoldingEditForm
        defaultAccountId={1}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );

    // Field set drift guard — these are the exact labels the form must
    // expose. Adding a field here means updating both surfaces' tests
    // (this single test, since the form is the single source of truth).
    expect(getByText("Name")).toBeTruthy();
    expect(getByText("Account")).toBeTruthy();
    expect(getByText("Symbol / ticker")).toBeTruthy();
    expect(getByText("Holding currency")).toBeTruthy();
    expect(getByText("Crypto asset")).toBeTruthy();
    expect(getByText("Note")).toBeTruthy();

    // Submit button reads "Add holding" in create mode.
    expect(getByText("Add holding")).toBeTruthy();

    // Delete button is HIDDEN in create mode.
    const deleteBtn = container.querySelector("button.text-destructive");
    expect(deleteBtn).toBeNull();
  });

  it("renders edit-mode field set without an Account dropdown", async () => {
    const { container, getByText, queryByText } = render(
      <HoldingEditForm
        holdingId={42}
        initialHolding={{
          id: 42,
          accountId: 1,
          name: "Bitcoin",
          symbol: "BTC",
          currency: "CAD",
          isCrypto: 1,
          note: "",
        }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );

    // Same field set MINUS the Account dropdown (account moves are
    // explicitly NOT supported here per CLAUDE.md "stale state" gotcha
    // on update_portfolio_holding's account-move branch).
    expect(getByText("Name")).toBeTruthy();
    expect(queryByText("Account")).toBeNull();
    expect(getByText("Symbol / ticker")).toBeTruthy();
    expect(getByText("Holding currency")).toBeTruthy();
    expect(getByText("Crypto asset")).toBeTruthy();
    expect(getByText("Note")).toBeTruthy();

    // Submit button reads "Save" in edit mode; Delete button visible.
    expect(getByText("Save")).toBeTruthy();
    const deleteBtn = container.querySelector("button.text-destructive");
    expect(deleteBtn).not.toBeNull();
  });

  it("disables the Name field on a canonical row (tickered)", async () => {
    const { container, getByText } = render(
      <HoldingEditForm
        holdingId={1}
        initialHolding={{
          id: 1,
          accountId: 1,
          name: "VCN.TO",
          symbol: "VCN.TO",
          currency: "CAD",
          isCrypto: 0,
          note: "",
        }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );

    // Tickered row → name input MUST be disabled. The hint copy MUST be
    // rendered next to the field (mirrors PR #77's UX decision).
    const nameInput = container.querySelector(
      'input[value="VCN.TO"]',
    ) as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    expect(nameInput!.disabled).toBe(true);
    expect(
      getByText(/Name is auto-managed for this holding type/),
    ).toBeTruthy();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const onCancel = vi.fn();
    const { getAllByText } = render(
      <HoldingEditForm
        holdingId={1}
        initialHolding={{
          id: 1,
          accountId: 1,
          name: "Custom",
          symbol: null,
          currency: "CAD",
          isCrypto: 0,
          note: "",
        }}
        onSave={() => {}}
        onCancel={onCancel}
      />,
    );

    // There may be a "Cancel" inside the delete-confirm, but in default
    // edit-mode state the bottom Cancel is the first match.
    const cancelBtns = getAllByText("Cancel");
    fireEvent.click(cancelBtns[0]);
    expect(onCancel).toHaveBeenCalled();
  });

  it("submits a POST to /api/portfolio in create mode", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/accounts") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ id: 1, name: "RRSP", currency: "CAD" }]),
        });
      }
      if (url === "/api/portfolio" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 99, name: "Custom" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const onSave = vi.fn();
    const { container, getByText } = render(
      <HoldingEditForm
        defaultAccountId={1}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    const nameInput = container.querySelector(
      'input[placeholder*="Apple"]',
    ) as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    fireEvent.change(nameInput!, { target: { value: "Custom" } });

    fireEvent.click(getByText("Add holding"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/portfolio" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
  });
});
