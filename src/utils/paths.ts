import fs from "node:fs";
import path from "node:path";

/**
 * Every runtime artifact lives under these two roots so the whole state of a
 * job is one directory you can zip, inspect or delete.
 *
 *   data/     durable job state (products, failures, checkpoint, logs, shots)
 *   exports/  generated Excel workbooks
 */
export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, "data");
export const EXPORT_DIR = path.join(ROOT, "exports");
export const LOG_DIR = path.join(DATA_DIR, "logs");
export const SCREENSHOT_DIR = path.join(DATA_DIR, "screenshots");

export const PRODUCTS_FILE = path.join(DATA_DIR, "products.jsonl");
export const FAILURES_FILE = path.join(DATA_DIR, "failures.jsonl");
export const CHECKPOINT_FILE = path.join(DATA_DIR, "checkpoint.json");
export const LOG_FILE = path.join(LOG_DIR, "job.jsonl");

/** Create every runtime directory. Safe to call repeatedly. */
export function ensureDirs(): void {
  for (const dir of [DATA_DIR, EXPORT_DIR, LOG_DIR, SCREENSHOT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Absolute path of the workbook for one listing page. */
export function pageWorkbookPath(pageNo: number): string {
  return path.join(EXPORT_DIR, `page-${pageNo}.xlsx`);
}

/** Absolute path of the merged "export all" workbook. */
export function masterWorkbookPath(): string {
  return path.join(EXPORT_DIR, "all-products.xlsx");
}
