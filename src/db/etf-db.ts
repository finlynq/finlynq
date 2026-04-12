// ETF data storage (disabled in PostgreSQL-only open-source mode)
// Kept for compatibility but all functions return empty/null results

export function getEtfInfoAll() {
  return [] as { id: number; symbol: string; full_name: string; total_holdings: number; updated_at: string; }[];
}
export function getEtfInfoBySymbol(symbol: string) {
  return undefined as { id: number; symbol: string; full_name: string; total_holdings: number; updated_at: string; } | undefined;
}
export function getEtfRegionsBySymbol(symbol: string) {
  return [] as { region: string; weight: number; }[];
}
export function getEtfSectorsBySymbol(symbol: string) {
  return [] as { sector: string; weight: number; }[];
}
export function getEtfConstituentsBySymbol(symbol: string) {
  return [] as { ticker: string; name: string; weight: number; sector: string; country: string; }[];
}
export function upsertEtfInfo(symbol: string, fullName: string, totalHoldings: number): void {}
export function replaceEtfRegions(symbol: string, regions: Record<string, number>): void {}
export function replaceEtfSectors(symbol: string, sectors: Record<string, number>): void {}
export function replaceEtfConstituents(symbol: string, constituents: { ticker: string; name: string; weight: number; sector: string; country: string }[]): void {}
export function seedEtfFromData(data: { symbol: string; fullName: string; regions: Record<string, number>; sectors: Record<string, number>; constituents: { ticker: string; name: string; weight: number; sector: string; country: string }[]; }): void {}
export function deleteEtfData(symbol: string): void {}
export function clearAllEtfData(): void {}
export function closeEtfConnection(): void {}
