import type { ProductRecord } from "../storage/types.js";

export interface ColumnDef {
  header: string;
  key: string;
  width: number;
  /** ExcelJS number format, applied to the whole data column. */
  numFmt?: string;
  /** Flatten a record into the cell value for this column. */
  value: (row: ProductRecord) => string | number | boolean | null;
}

/** Render the structured fields as readable text — never raw JSON. */
function funnelText(row: ProductRecord): string | null {
  const f = row.conversionFunnel;
  if (!f) return null;
  return `Impression→Click ${f.impressionToClick}%; Click→Cart ${f.clickToCart}%; Cart→Sale ${f.cartToSale}%`;
}

function salesRankText(row: ProductRecord): string | null {
  if (!row.salesRank || row.salesRank.length === 0) return null;
  return row.salesRank.map((r) => `${r.category}: #${r.rank}`).join("; ");
}

function returnReasonsText(row: ProductRecord): string | null {
  if (!row.topReturnReasons || row.topReturnReasons.length === 0) return null;
  return row.topReturnReasons.map((r) => `${r.reason}: ${r.percentage}%`).join("; ");
}

/**
 * The workbook schema — one definition shared by the page exports and the
 * master export, so every generated file has identical columns and formatting.
 *
 * Only scraped fields plus the minimal locating context (page / URL) appear.
 */
export const COLUMNS: ColumnDef[] = [
  { header: "Page", key: "page", width: 8, numFmt: "0", value: (r) => r.page },
  { header: "#", key: "productIndex", width: 6, numFmt: "0", value: (r) => r.productIndex },
  { header: "Success", key: "success", width: 10, value: (r) => (r.success ? "Yes" : "No") },
  { header: "FSN", key: "fsn", width: 20, value: (r) => r.fsn },
  { header: "Price", key: "price", width: 12, numFmt: '₹#,##0;[Red]-₹#,##0', value: (r) => r.price },
  { header: "Rating", key: "rating", width: 10, numFmt: "0.0", value: (r) => r.rating },
  { header: "Review Count", key: "reviewCount", width: 14, numFmt: "#,##0", value: (r) => r.reviewCount },
  { header: "Return Policy", key: "returnPolicy", width: 22, value: (r) => r.returnPolicy },
  { header: "Quality", key: "quality", width: 14, value: (r) => r.quality },
  { header: "Return Rate", key: "returnRate", width: 13, value: (r) => r.returnRate },
  { header: "Return Rate Color", key: "returnRateColor", width: 18, value: (r) => r.returnRateColor },
  {
    header: "Start Selling Enabled",
    key: "isStartSellingEnable",
    width: 20,
    value: (r) => (r.isStartSellingEnable === null ? null : r.isStartSellingEnable ? "Yes" : "No"),
  },
  { header: "Conversion Funnel", key: "conversionFunnel", width: 46, value: funnelText },
  { header: "Sales Rank", key: "salesRank", width: 40, value: salesRankText },
  { header: "Top Return Reasons", key: "topReturnReasons", width: 40, value: returnReasonsText },
  { header: "Latch On URL", key: "latchOnUrl", width: 44, value: (r) => r.latchOnUrl },
  { header: "Start Selling URL", key: "startSellingUrl", width: 44, value: (r) => r.startSellingUrl },
  { header: "Product URL", key: "url", width: 50, value: (r) => r.url },
  { header: "Error", key: "error", width: 40, value: (r) => r.error },
  { header: "Scraped At", key: "scrapedAt", width: 22, value: (r) => r.scrapedAt },
];
