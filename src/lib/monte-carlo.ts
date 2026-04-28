// Monte Carlo simulation for FIRE/retirement planning
// Uses Box-Muller transform for normal distribution

export type MonteCarloParams = {
  currentInvestments: number;
  monthlySavings: number;
  annualReturn: number; // expected mean return (%)
  annualVolatility: number; // standard deviation of returns (%)
  inflation: number; // annual inflation (%)
  yearsToSimulate: number;
  numSimulations: number; // typically 1000
  withdrawalRate: number; // safe withdrawal rate (%)
  annualExpenses: number;
};

export type MonteCarloResult = {
  percentilePaths: {
    p10: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p90: number[];
  };
  successProbability: number; // % of simulations where portfolio survives
  fireNumber: number;
  years: number[];
  finalValues: {
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
  };
};

// Box-Muller transform: generate normally distributed random number
function boxMuller(): number {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export function calculateHistoricalVolatility(returns: number[]): number {
  if (returns.length < 2) return 15; // default volatility
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance =
    returns.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

export function runMonteCarloSimulation(params: MonteCarloParams): MonteCarloResult {
  const {
    currentInvestments,
    monthlySavings,
    annualReturn,
    annualVolatility,
    inflation,
    yearsToSimulate,
    numSimulations,
    withdrawalRate,
    annualExpenses,
  } = params;

  const fireNumber = annualExpenses / (withdrawalRate / 100);
  const realReturn = (annualReturn - inflation) / 100;
  const realVolatility = annualVolatility / 100;

  // Run all simulations, store final year balances for each simulation at each year
  const allPaths: number[][] = [];
  let successCount = 0;

  for (let sim = 0; sim < numSimulations; sim++) {
    const path: number[] = [currentInvestments];
    let balance = currentInvestments;
    let survived = true;

    for (let y = 1; y <= yearsToSimulate; y++) {
      // Generate random annual return using normal distribution
      const randomReturn = realReturn + realVolatility * boxMuller();

      // Apply return and add savings
      balance = balance * (1 + randomReturn) + monthlySavings * 12;

      if (balance < 0) {
        balance = 0;
        survived = false;
      }

      path.push(Math.round(balance * 100) / 100);
    }

    allPaths.push(path);
    // Success = portfolio reaches FIRE number at some point and doesn't go to zero
    if (survived && path[path.length - 1] >= fireNumber) {
      successCount++;
    }
  }

  // Calculate percentiles at each year
  const years = Array.from({ length: yearsToSimulate + 1 }, (_, i) => i);
  const p10: number[] = [];
  const p25: number[] = [];
  const p50: number[] = [];
  const p75: number[] = [];
  const p90: number[] = [];

  for (let y = 0; y <= yearsToSimulate; y++) {
    const valuesAtYear = allPaths.map((path) => path[y]).sort((a, b) => a - b);
    p10.push(Math.round(percentile(valuesAtYear, 10)));
    p25.push(Math.round(percentile(valuesAtYear, 25)));
    p50.push(Math.round(percentile(valuesAtYear, 50)));
    p75.push(Math.round(percentile(valuesAtYear, 75)));
    p90.push(Math.round(percentile(valuesAtYear, 90)));
  }

  return {
    percentilePaths: { p10, p25, p50, p75, p90 },
    successProbability: Math.round((successCount / numSimulations) * 1000) / 10,
    fireNumber: Math.round(fireNumber),
    years,
    finalValues: {
      p10: p10[p10.length - 1],
      p25: p25[p25.length - 1],
      p50: p50[p50.length - 1],
      p75: p75[p75.length - 1],
      p90: p90[p90.length - 1],
    },
  };
}

function percentile(sortedArr: number[], pct: number): number {
  const idx = (pct / 100) * (sortedArr.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedArr[lower];
  const weight = idx - lower;
  return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
}
