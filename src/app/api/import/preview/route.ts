import { NextRequest, NextResponse } from "next/server";
import { csvToRawTransactions } from "@/lib/csv-parser";
import { parsePdfToTransactions } from "@/lib/pdf-parser";
import { parseExcelSheets } from "@/lib/excel-parser";
import { parseOfx } from "@/lib/ofx-parser";
import { previewImport } from "@/lib/import-pipeline";
import { requireUnlock } from "@/lib/require-unlock";

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv") {
      const text = await file.text();
      const rows = csvToRawTransactions(text);
      const preview = previewImport(rows);
      return NextResponse.json({ type: "csv", ...preview });
    }

    if (ext === "ofx" || ext === "qfx") {
      const text = await file.text();
      const ofxResult = parseOfx(text);

      if (ofxResult.transactions.length === 0) {
        return NextResponse.json(
          { error: "No transactions found in OFX/QFX file." },
          { status: 400 },
        );
      }

      // Return OFX metadata + preview — account assignment happens on the client
      return NextResponse.json({
        type: "ofx",
        account: ofxResult.account,
        balanceAmount: ofxResult.balanceAmount,
        balanceDate: ofxResult.balanceDate,
        dateRange: ofxResult.dateRange,
        currency: ofxResult.currency,
        transactionCount: ofxResult.transactions.length,
        transactions: ofxResult.transactions,
      });
    }

    if (ext === "pdf") {
      const buffer = Buffer.from(await file.arrayBuffer());
      const { rows, confidence, rawText } = await parsePdfToTransactions(buffer);
      const preview = previewImport(rows);
      return NextResponse.json({ type: "pdf", confidence, rawText, ...preview });
    }

    if (ext === "xlsx" || ext === "xls") {
      const buffer = Buffer.from(await file.arrayBuffer());
      const sheets = parseExcelSheets(buffer);
      return NextResponse.json({ type: "excel", sheets });
    }

    return NextResponse.json({ error: "Unsupported file type. Use CSV, Excel, PDF, OFX, or QFX." }, { status: 400 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
