/**
 * Unit tests for the shared CSV export util (FINLYNQ-144).
 *
 * `exportCsv`/`serializeCsv` back the /transactions filtered-view export (and
 * any future client CSV download). Financial-data CSV correctness matters, so
 * these tests pin the RFC-4180 quoting rules: a field is quoted iff it contains
 * a comma, a double-quote, a CR, or an LF; embedded quotes are doubled; rows are
 * CRLF-joined; and a UTF-8 BOM is prepended by default (off via `{ bom: false }`).
 */
import { describe, it, expect } from "vitest";
import {
  csvField,
  buildCsvString,
  serializeCsv,
  type CsvColumn,
} from "@/lib/csv-export";

const BOM = "﻿";

describe("csvField (FINLYNQ-144)", () => {
  it("leaves a plain field unquoted", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(42)).toBe("42");
  });

  it("coerces null/undefined to an empty string", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quotes a field containing a comma", () => {
    expect(csvField("a,b")).toBe('"a,b"');
  });

  it("quotes and doubles an embedded double-quote", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a field containing a newline or carriage return", () => {
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField("a\rb")).toBe('"a\rb"');
  });
});

describe("buildCsvString (FINLYNQ-144)", () => {
  it("joins the header + rows with CRLF and quotes per cell", () => {
    const out = buildCsvString(
      ["Name", "Amount"],
      [
        ["Acme, Inc.", -12.5],
        ["Plain", 3],
      ],
    );
    expect(out).toBe('Name,Amount\r\n"Acme, Inc.",-12.5\r\nPlain,3');
  });
});

describe("serializeCsv (FINLYNQ-144)", () => {
  type Row = { payee: string; amount: number };
  const columns: CsvColumn<Row>[] = [
    { header: "Payee", accessor: (r) => r.payee },
    { header: "Amount", accessor: (r) => r.amount },
  ];

  it("serializes a payee with a comma, an embedded quote, AND a newline into one RFC-4180-quoted field, with a BOM by default", () => {
    const rows: Row[] = [{ payee: 'Acme, "Best" Co.\nDept', amount: -12.5 }];
    const out = serializeCsv(rows, columns);
    // BOM prepended, header CRLF, the whole payee is ONE quoted field with the
    // inner quotes doubled, the embedded comma + newline preserved verbatim.
    expect(out).toBe(
      `${BOM}Payee,Amount\r\n"Acme, ""Best"" Co.\nDept",-12.5`,
    );
    // First character is the BOM so Excel detects UTF-8.
    expect(out.charCodeAt(0)).toBe(0xfeff);
  });

  it("omits the BOM when { bom: false }", () => {
    const rows: Row[] = [{ payee: "Plain", amount: 1 }];
    const out = serializeCsv(rows, columns, { bom: false });
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
    expect(out).toBe("Payee,Amount\r\nPlain,1");
  });

  it("emits a header-only line for an empty row set", () => {
    const out = serializeCsv([], columns, { bom: false });
    expect(out).toBe("Payee,Amount");
  });
});
