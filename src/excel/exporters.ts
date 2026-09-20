import fs from "node:fs";
import type { ProductStore } from "../storage/productStore.js";
import type { CheckpointStore } from "../checkpoint/checkpointStore.js";
import { logger } from "../logger/logger.js";
import { LogEvent } from "../logger/events.js";
import { masterWorkbookPath, pageWorkbookPath } from "../utils/paths.js";
import { writeWorkbook } from "./workbook.js";

export interface ExportResult {
  path: string;
  rows: number;
  /** True when an existing file was reused instead of regenerated. */
  skipped: boolean;
}

/**
 * Write `exports/page-N.xlsx` for one completed listing page.
 *
 * Called by the runner the moment a page's last product is persisted — the
 * export never waits for the whole job to finish.
 *
 * Idempotent by design: if the checkpoint says the file was generated AND the
 * file is still on disk, we return without rewriting it. That is what stops a
 * resumed run from regenerating already-exported pages. Pass `force: true` for
 * the dashboard's manual "Export Current Page" button.
 */
export async function exportPage(
  pageNo: number,
  products: ProductStore,
  checkpoint: CheckpointStore,
  options: { force?: boolean } = {},
): Promise<ExportResult> {
  const target = pageWorkbookPath(pageNo);

  if (!options.force && checkpoint.isExcelGenerated(pageNo) && fs.existsSync(target)) {
    return { path: target, rows: products.byPage(pageNo).length, skipped: true };
  }

  const rows = products.byPage(pageNo);
  await writeWorkbook(target, rows, `Page ${pageNo}`);
  checkpoint.markExcelGenerated(pageNo);

  logger.info(LogEvent.EXCEL_GENERATED, `Generated page-${pageNo}.xlsx (${rows.length} products)`, {
    page: pageNo,
    rows: rows.length,
    path: target,
  });

  return { path: target, rows: rows.length, skipped: false };
}

/**
 * Merge every scraped product into one workbook. Always regenerated on demand,
 * since new products may have landed since the last call.
 */
export async function exportAll(products: ProductStore): Promise<ExportResult> {
  const rows = [...products.all()].sort(
    (a, b) => a.page - b.page || a.productIndex - b.productIndex,
  );
  const target = masterWorkbookPath();
  await writeWorkbook(target, rows, "All Products");

  logger.info(LogEvent.EXCEL_GENERATED, `Generated all-products.xlsx (${rows.length} products)`, {
    rows: rows.length,
    path: target,
  });

  return { path: target, rows: rows.length, skipped: false };
}
