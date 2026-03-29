import { PDFParse } from "pdf-parse";
import type { RawTransaction } from "./import-pipeline";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfParser = any;

// Date patterns: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, MMM DD YYYY, etc.
const DATE_PATTERNS = [
  /(\d{4}-\d{2}-\d{2})/,                          // 2024-01-15
  /(\d{1,2}\/\d{1,2}\/\d{4})/,                    // 01/15/2024
  /(\d{1,2}-\d{1,2}-\d{4})/,                      // 01-15-2024
  /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})/i,  // Jan 15, 2024
];

// Amount patterns: $1,234.56 or -1234.56 or (1,234.56)
const AMOUNT_PATTERN = /[-−]?\$?\s*[\d,]+\.\d{2}|\([\d,]+\.\d{2}\)/g;

function extractDate(line: string): string | null {
  for (const pattern of DATE_PATTERNS) {
    const match = line.match(pattern);
    if (match) return normalizeDate(match[1]);
  }
  return null;
}

function normalizeDate(dateStr: string): string {
  // Try YYYY-MM-DD first
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

  // Try MMM DD, YYYY
  const monthNames: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const namedMatch = dateStr.match(/(\w{3})\s+(\d{1,2}),?\s+(\d{4})/i);
  if (namedMatch) {
    const month = monthNames[namedMatch[1].toLowerCase()];
    if (month) return `${namedMatch[3]}-${month}-${namedMatch[2].padStart(2, "0")}`;
  }

  // Try MM/DD/YYYY or MM-DD-YYYY
  const slashMatch = dateStr.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
  }

  return dateStr;
}

function parseAmount(amountStr: string): number {
  let cleaned = amountStr.replace(/[$\s,]/g, "").replace("−", "-");
  // Handle parenthesized negatives: (123.45) -> -123.45
  if (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    cleaned = "-" + cleaned.slice(1, -1);
  }
  return parseFloat(cleaned) || 0;
}

export interface PdfParseResult {
  rows: RawTransaction[];
  confidence: number;
  rawText: string;
}

export async function parsePdfToTransactions(buffer: Buffer): Promise<PdfParseResult> {
  const parser: PdfParser = new PDFParse({ verbosity: 0 });
  await parser.load(buffer);
  const info = await parser.getInfo();
  const pageCount: number = info?.numPages ?? 1;

  // Extract text from all pages
  let rawText = "";
  for (let i = 1; i <= pageCount; i++) {
    const pageText: string = await parser.getText(i);
    rawText += pageText + "\n";
  }

  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

  const rows: RawTransaction[] = [];
  let linesWithDates = 0;

  for (const line of lines) {
    const date = extractDate(line);
    if (!date) continue;

    linesWithDates++;
    const amounts = line.match(AMOUNT_PATTERN);
    if (!amounts || amounts.length === 0) continue;

    // Last amount is typically the transaction amount (rightmost column)
    const amount = parseAmount(amounts[amounts.length - 1]);
    if (amount === 0) continue;

    // Extract payee: text between date and first amount
    const dateMatch = line.match(DATE_PATTERNS.find((p) => p.test(line))!);
    const dateEnd = dateMatch ? (dateMatch.index ?? 0) + dateMatch[0].length : 0;
    const firstAmountIdx = line.indexOf(amounts[0]);
    const payee = line.slice(dateEnd, firstAmountIdx).trim()
      .replace(/^\s*[-–]\s*/, "") // Remove leading dashes
      .trim();

    rows.push({
      date,
      account: "", // User must map this
      amount,
      payee: payee || "Unknown",
      currency: "CAD",
      note: "",
    });
  }

  const confidence = lines.length > 0
    ? Math.min(rows.length / Math.max(linesWithDates, 1), 1)
    : 0;

  return { rows, confidence, rawText };
}
