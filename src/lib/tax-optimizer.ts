// Feature 8: Tax Optimization Dashboard (Canadian)

// TFSA contribution limits by year
const TFSA_LIMITS: Record<number, number> = {
  2009: 5000, 2010: 5000, 2011: 5000, 2012: 5000, 2013: 5500,
  2014: 5500, 2015: 10000, 2016: 5500, 2017: 5500, 2018: 5500,
  2019: 6000, 2020: 6000, 2021: 6000, 2022: 6000, 2023: 6500,
  2024: 7000, 2025: 7000, 2026: 7000,
};

export function getTFSALimit(year: number): number {
  return TFSA_LIMITS[year] ?? 7000;
}

export function getTotalTFSARoom(startYear: number = 2009, currentYear: number = 2026): number {
  let total = 0;
  for (let y = startYear; y <= currentYear; y++) {
    total += getTFSALimit(y);
  }
  return total;
}

// RRSP contribution calculation
export function getRRSPRoom(previousYearIncome: number, previousYearRoomUsed: number): number {
  const limit = Math.min(previousYearIncome * 0.18, 31560); // 2026 limit
  return Math.max(limit - previousYearRoomUsed, 0);
}

// RESP grant calculation
export function getRESPGrant(annualContribution: number): number {
  // CESG: 20% on first $2,500 = max $500/year, lifetime max $7,200
  return Math.min(annualContribution * 0.2, 500);
}

// Asset location advice
export type AssetLocationAdvice = {
  holding: string;
  symbol: string;
  currentAccount: string;
  recommendedAccountType: string;
  reason: string;
};

export function getAssetLocationAdvice(
  holdings: { name: string; symbol: string; accountName: string; accountType: string }[]
): AssetLocationAdvice[] {
  const advice: AssetLocationAdvice[] = [];

  for (const h of holdings) {
    if (!h.symbol) continue;

    // US dividend-paying ETFs should be in RRSP (withholding tax)
    if (
      (h.symbol.includes("VUN") || h.symbol === "VTI" || h.symbol.includes("VUAA") || h.symbol.includes("VUSD")) &&
      !h.accountName.includes("RRSP")
    ) {
      advice.push({
        holding: h.name,
        symbol: h.symbol,
        currentAccount: h.accountName,
        recommendedAccountType: "RRSP",
        reason: "US stocks in RRSP avoid 15% withholding tax on dividends via Canada-US tax treaty",
      });
    }

    // Canadian stocks should be in TFSA or non-registered (eligible dividends)
    if (
      h.symbol.includes("VCN") &&
      h.accountName.includes("RRSP")
    ) {
      advice.push({
        holding: h.name,
        symbol: h.symbol,
        currentAccount: h.accountName,
        recommendedAccountType: "TFSA or Non-Registered",
        reason: "Canadian dividends get dividend tax credit in non-registered, tax-free growth in TFSA",
      });
    }

    // High-dividend international in RRSP
    if (
      (h.symbol.includes("VHYD") || h.symbol.includes("VHYA")) &&
      !h.accountName.includes("RRSP")
    ) {
      advice.push({
        holding: h.name,
        symbol: h.symbol,
        currentAccount: h.accountName,
        recommendedAccountType: "RRSP",
        reason: "High-dividend funds benefit from RRSP's withholding tax advantages",
      });
    }
  }

  return advice;
}

// Marginal tax rates (Ontario 2026 approximate)
const FEDERAL_BRACKETS = [
  { limit: 55867, rate: 15 },
  { limit: 111733, rate: 20.5 },
  { limit: 154906, rate: 26 },
  { limit: 220000, rate: 29 },
  { limit: Infinity, rate: 33 },
];

const ONTARIO_BRACKETS = [
  { limit: 51446, rate: 5.05 },
  { limit: 102894, rate: 9.15 },
  { limit: 150000, rate: 11.16 },
  { limit: 220000, rate: 12.16 },
  { limit: Infinity, rate: 13.16 },
];

export function getMarginalRate(income: number): { federal: number; provincial: number; combined: number } {
  const fed = FEDERAL_BRACKETS.find((b) => income <= b.limit)?.rate ?? 33;
  const prov = ONTARIO_BRACKETS.find((b) => income <= b.limit)?.rate ?? 13.16;
  return { federal: fed, provincial: prov, combined: fed + prov };
}

export function rrspVsTfsa(income: number, contribution: number): {
  rrspBenefit: number;
  tfsaBenefit: string;
  recommendation: string;
} {
  const marginal = getMarginalRate(income);
  const rrspTaxSaved = contribution * (marginal.combined / 100);

  return {
    rrspBenefit: Math.round(rrspTaxSaved * 100) / 100,
    tfsaBenefit: "Tax-free growth and withdrawals (no immediate deduction)",
    recommendation:
      marginal.combined > 35
        ? `RRSP recommended at ${marginal.combined}% marginal rate — save $${rrspTaxSaved.toFixed(0)} now`
        : `TFSA recommended at ${marginal.combined}% marginal rate — tax-free growth is more valuable`,
  };
}
