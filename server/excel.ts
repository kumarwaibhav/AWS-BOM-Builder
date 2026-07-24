/**
 * Excel BOM generation with exceljs.
 * Column headers must match EXACTLY:
 * S.No. | AWS Region | AWS Service Category | AWS Service Name |
 * AWS Service Description/ Config | AWS Qty | AWS UOM | AWS Billed Cost USD
 */
import ExcelJS from "exceljs";

export interface ExcelBomRow {
  sno: number;
  region: string;
  serviceCategory: string;
  serviceName: string;
  description: string;
  quantity: number | null;
  uom: string | null;
  costUsd: number;
}

export interface ExcelMeta {
  fileName: string;
  billingPeriod: string | null;
  accountId: string | null;
  grandTotalUsd: number | null;
  calculatedTotalUsd?: number;
}

export async function generateBomExcel(
  rows: ExcelBomRow[],
  meta: ExcelMeta
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AWS Bill to BOM Converter";
  wb.created = new Date();

  const ws = wb.addWorksheet("AWS BOM", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = [
    { header: "S.No.", key: "sno", width: 8 },
    { header: "AWS Region", key: "region", width: 26 },
    { header: "AWS Service Category", key: "serviceCategory", width: 32 },
    { header: "AWS Service Name", key: "serviceName", width: 34 },
    { header: "AWS Service Description/ Config", key: "description", width: 80 },
    { header: "AWS Qty", key: "quantity", width: 16 },
    { header: "AWS UOM", key: "uom", width: 18 },
    { header: "AWS Billed Cost USD", key: "costUsd", width: 20 },
  ];

  // Header styling: bold white on black (Swiss style)
  const headerRow = ws.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11, name: "Arial" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF000000" } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = {
      top: { style: "thin" }, bottom: { style: "medium" },
      left: { style: "thin" }, right: { style: "thin" },
    };
  });

  for (const row of rows) {
    const r = ws.addRow({
      sno: row.sno,
      region: row.region,
      serviceCategory: row.serviceCategory,
      serviceName: row.serviceName,
      description: row.description,
      quantity: row.quantity,
      uom: row.uom ?? "",
      costUsd: row.costUsd,
    });
    r.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { size: 10, name: "Arial" };
      cell.alignment = { vertical: "top", wrapText: col === 5 };
      cell.border = {
        top: { style: "hair" }, bottom: { style: "hair" },
        left: { style: "thin" }, right: { style: "thin" },
      };
    });
    r.getCell(6).numFmt = "#,##0.000";
    r.getCell(8).numFmt = "#,##0.00";
  }

  // Totals row
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalRow = ws.addRow({
    sno: "",
    region: "",
    serviceCategory: "",
    serviceName: "",
    description: "TOTAL",
    quantity: null,
    uom: "",
    costUsd: Math.round(totalCost * 100) / 100,
  });
  totalRow.eachCell({ includeEmpty: true }, cell => {
    cell.font = { bold: true, size: 11, name: "Arial" };
    cell.border = { top: { style: "medium" }, bottom: { style: "medium" } };
  });
  totalRow.getCell(8).numFmt = "#,##0.00";

  // Metadata sheet
  const info = wb.addWorksheet("Bill Info");
  info.columns = [
    { header: "Field", key: "f", width: 30 },
    { header: "Value", key: "v", width: 60 },
  ];
  info.getRow(1).font = { bold: true };
  info.addRow({ f: "Source File", v: meta.fileName });
  info.addRow({ f: "Billing Period", v: meta.billingPeriod ?? "—" });
  info.addRow({ f: "Account ID", v: meta.accountId ?? "—" });
  info.addRow({ f: "Estimated Grand Total (USD, incl. tax)", v: meta.grandTotalUsd ?? "—" });
  info.addRow({ f: "Line Items", v: rows.length });
  info.addRow({ f: "Pre-tax Line-Item Total (USD)", v: Math.round(totalCost * 100) / 100 });
  info.addRow({ f: "Generated", v: new Date().toISOString() });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

