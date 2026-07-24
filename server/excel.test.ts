/**
 * Excel generation tests: exact headers and data rows.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { generateBomExcel } from "./excel";

const EXACT_HEADERS = [
  "S.No.",
  "AWS Region",
  "AWS Service Category",
  "AWS Service Name",
  "AWS Service Description/ Config",
  "AWS Qty",
  "AWS UOM",
  "AWS Billed Cost USD",
];

describe("generateBomExcel", () => {
  it("produces a workbook with the exact required column headers", async () => {
    const buffer = await generateBomExcel(
      [
        {
          sno: 1,
          region: "Asia Pacific (Mumbai)",
          serviceCategory: "Compute",
          serviceName: "Elastic Compute Cloud",
          description: "$0.0224 per On Demand Linux t3.micro Instance Hour",
          quantity: 744,
          uom: "Hrs",
          costUsd: 16.67,
        },
        {
          sno: 2,
          region: "Global",
          serviceCategory: "Networking & Content Delivery",
          serviceName: "Route 53",
          description: "Hosted Zones",
          quantity: null,
          uom: null,
          costUsd: -1.5,
        },
      ],
      { fileName: "test.pdf", billingPeriod: "Jun 2026", accountId: "1234", grandTotalUsd: 15.17 }
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws).toBeDefined();

    // find the header row (metadata block may precede it)
    let headerRowIdx = -1;
    ws.eachRow((row, idx) => {
      if (row.getCell(1).value === "S.No." && headerRowIdx === -1) headerRowIdx = idx;
    });
    expect(headerRowIdx).toBeGreaterThan(0);

    const headerRow = ws.getRow(headerRowIdx);
    EXACT_HEADERS.forEach((h, i) => {
      expect(headerRow.getCell(i + 1).value).toBe(h);
    });

    // data row values
    const r1 = ws.getRow(headerRowIdx + 1);
    expect(r1.getCell(1).value).toBe(1);
    expect(r1.getCell(2).value).toBe("Asia Pacific (Mumbai)");
    expect(r1.getCell(6).value).toBe(744);
    expect(r1.getCell(8).value).toBe(16.67);

    const r2 = ws.getRow(headerRowIdx + 2);
    expect(r2.getCell(8).value).toBe(-1.5);
  });
});

