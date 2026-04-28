// Lazy-loaded to prevent DOMMatrix/canvas errors at module evaluation time in Next.js builds
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PDFParse: any;
import type { RawTransaction } from "./import-pipeline";
import { normalizeDate, parseAmount } from "./csv-parser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfParser = any;

// Date patterns: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, MMM DD YYYY, etc.
const DATE_PATTERNS = [
  /(\d{4}-\d{2}-\d{2})/,                          // 2024-01-15
  /(\d{1,2}\/\d{1,2}\/\d{4})/,                    // 01/15/2024
  /(\d{1,2}-\d{1,2}-\d{4})/,                      // 01-15-2024
  /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})/i,  // Jan 15, 2024
];

// Amount patterns: $1,234.56 or -1234.56 or (1,234.56) or −$1,234.56
const AMOUNT_PATTERN = /[-−]?\$?\s*[\d,]+\.\d{2}|\([\$\s]*[\d,]+\.\d{2}\)/g;

function extractDate(line: string): string | null {
  for (const pattern of DATE_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      const normalized = normalizeDate(match[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

export interface PdfParseResult {
  rows: RawTransaction[];
  confidence: number;
  rawText: string;
  errors: string[];
}

/** Max file size for PDF parsing (50MB) */
const MAX_PDF_SIZE = 50 * 1024 * 1024;

export async function parsePdfToTransactions(buffer: Buffer): Promise<PdfParseResult> {
  const errors: string[] = [];

  if (buffer.length === 0) {
    return { rows: [], confidence: 0, rawText: "", errors: ["PDF file is empty"] };
  }

  if (buffer.length > MAX_PDF_SIZE) {
    return { rows: [], confidence: 0, rawText: "", errors: ["PDF file exceeds 50MB size limit"] };
  }

  let rawText = "";
  try {
    if (!PDFParse) ({ PDFParse } = await import("pdf-parse"));
    const parser: PdfParser = new PDFParse({ verbosity: 0 });
    await parser.load(buffer);
    const info = await parser.getInfo();
    const pageCount: number = info?.numPages ?? 1;

    for (let i = 1; i <= pageCount; i++) {
      try {
        const pageText: string = await parser.getText(i);
        rawText += pageText + "\n";
      } catch {
        errors.push(`Could not extract text from page ${i}`);
      }
    }
  } catch (e) {
    return {
      rows: [],
      confidence: 0,
      rawText: "",
      errors: [`Could not read PDF: ${e instanceof Error ? e.message : "The file may be corrupted or password-protected"}`],
    };
  }

  if (!rawText.trim()) {
    return {
      rows: [],
      confidence: 0,
      rawText,
      errors: ["No text could be extracted from this PDF. It may be a scanned document or image-based PDF."],
    };
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
    if (isNaN(amount) || amount === 0) continue;

    // Extract payee: text between date and first amount
    const dateMatch = line.match(DATE_PATTERNS.find((p) => p.test(line))!);
    const dateEnd = dateMatch ? (dateMatch.index ?? 0) + dateMatch[0].length : 0;
    const firstAmountIdx = line.indexOf(amounts[0]);
    const payee = line.slice(dateEnd, firstAmountIdx).trim()
      .replace(/^\s*[-–]\s*/, "")
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

  if (rows.length === 0 && linesWithDates > 0) {
    errors.push("Found dates but could not extract transaction amounts. The PDF layout may not be supported.");
  } else if (rows.length === 0) {
    errors.push("No transactions found in this PDF. Make sure it contains bank statement data.");
  }

  return { rows, confidence, rawText, errors: errors.length > 0 ? errors : [] };
}
