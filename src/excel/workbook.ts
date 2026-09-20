import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import type { ProductRecord } from "../storage/types.js";
import { COLUMNS } from "./columns.js";

/** Header fill + font, shared by every generated sheet. */
const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F3A8A" },
};

/**
 * Build and write one styled workbook.
 *
 * Formatting applied, per spec:
 *   - bold white-on-navy header row
 *   - auto column width (seeded from the schema, grown to fit real content)
 *   - frozen header row
 *   - autofilter across the whole used range
 *   - number formats for price / rating / counts
 */
export async function writeWorkbook(
  filePath: string,
  rows: readonly ProductRecord[],
  sheetName: string,
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  // Excel forbids : \ / ? * [ ] in sheet names and caps them at 31 chars.
  const sheet = workbook.addWorksheet(sheetName.replace(/[:\\/?*[\]]/g, "-").slice(0, 31));

  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  for (const row of rows) {
    const values: Record<string, string | number | boolean | null> = {};
    for (const column of COLUMNS) values[column.key] = column.value(row);
    sheet.addRow(values);
  }

  // ---- header styling ----
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: "middle", horizontal: "left" };
  header.height = 22;

  // ---- number formats + auto width ----
  COLUMNS.forEach((definition, i) => {
    const column = sheet.getColumn(i + 1);
    if (definition.numFmt) column.numFmt = definition.numFmt;

    // Grow the seeded width to fit the widest real value, within sane bounds.
    let widest = definition.header.length;
    column.eachCell({ includeEmpty: false }, (cell) => {
      const text = cell.value === null || cell.value === undefined ? "" : String(cell.value);
      if (text.length > widest) widest = text.length;
    });
    column.width = Math.min(60, Math.max(definition.width, widest + 2));
  });

  // ---- freeze header + filter ----
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: COLUMNS.length },
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}
