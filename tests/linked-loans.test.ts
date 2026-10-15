/**
 * An account links to the loan that tracks it (2026-10-12, owner request), and
 * Loans is visible without Developer mode.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupLoansByAccount, loanHref } from "@/lib/hooks/useLinkedLoans";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("groupLoansByAccount", () => {
  it("groups loans under the account they are linked to", () => {
    const map = groupLoansByAccount([
      { id: 1, name: "Car loan", accountId: 7 },
      { id: 2, name: "Top-up", accountId: 7 },
      { id: 3, name: "Mortgage", accountId: 9 },
    ]);
    expect(map.get(7)).toEqual([
      { id: 1, name: "Car loan" },
      { id: 2, name: "Top-up" },
    ]);
    expect(map.get(9)).toEqual([{ id: 3, name: "Mortgage" }]);
  });

  it("leaves out a loan with no linked account", () => {
    const map = groupLoansByAccount([
      { id: 1, name: "Unlinked", accountId: null },
      { id: 2, name: "Also unlinked" },
    ]);
    expect(map.size).toBe(0);
  });

  // A loan whose name could not be decrypted still has to be reachable.
  it("gives a nameless loan a usable label", () => {
    const map = groupLoansByAccount([
      { id: 1, name: null, accountId: 7 },
      { id: 2, name: "   ", accountId: 7 },
    ]);
    expect(map.get(7)).toEqual([
      { id: 1, name: "Loan" },
      { id: 2, name: "Loan" },
    ]);
  });

  it("an account with no loan has no entry", () => {
    expect(groupLoansByAccount([{ id: 1, name: "Car loan", accountId: 7 }]).get(8)).toBeUndefined();
  });
});

describe("where the link goes", () => {
  it("opens the loan's own panel on the Loans page", () => {
    expect(loanHref(24)).toBe("/loans?loan=24");
    // ...which the Loans page reads to open that loan.
    expect(read("src/app/(app)/loans/page.tsx")).toContain('params.get("loan")');
  });

  it("both account screens use the shared hook, not their own fetch", () => {
    for (const p of ["src/app/(app)/accounts/page.tsx", "src/app/(app)/accounts/[id]/page.tsx"]) {
      const src = read(p);
      expect(src, p).toContain("useLinkedLoans()");
      expect(src, p).toContain("loanHref(l.id)");
    }
  });

  it("the loans list links back to each loan's account", () => {
    expect(read("src/app/(app)/loans/_components/loans-list.tsx")).toContain("href={`/accounts/${l.accountId}`}");
  });
});

describe("Loans needs no Developer mode", () => {
  it("the page, its API routes and the sidebar entry carry no dev-mode gate", () => {
    for (const p of [
      "src/app/(app)/loans/page.tsx",
      "src/app/api/loans/route.ts",
      "src/app/api/loans/interest/route.ts",
      "src/app/api/loans/schedule/route.ts",
    ]) {
      expect(read(p), p).not.toMatch(/DevModeGuard|requireDevMode|useDevMode/);
    }
    const nav = read("src/components/nav.tsx");
    const entry = nav.split("\n").find((l) => l.includes('href: "/loans"'));
    expect(entry).toBeDefined();
    expect(entry).not.toContain('mode: "dev"');
  });
});
