import type {
  ConversionFunnel,
  SalesRankEntry,
  ReturnReason,
} from "../productData.js";

/**
 * One persisted product row.
 *
 * The scraped fields are EXACTLY the ones the existing scraper produces — no
 * invented data. The only rename happens at this boundary: the scraper's
 * `isStartSellingUrlEnable` is stored as `isStartSellingEnable`.
 *
 * Everything outside `scraped context` is job bookkeeping (which page/slot the
 * product came from, and when we wrote it), never scraped content.
 */
export interface ProductRecord {
  // ---- scraped fields (verbatim from the existing scraper) ----
  success: boolean;
  fsn: string | null;
  price: number | null;
  rating: number | null;
  reviewCount: number | null;
  returnPolicy: string | null;
  conversionFunnel: ConversionFunnel | null;
  salesRank: SalesRankEntry[] | null;
  quality: string | null;
  latchOnUrl: string | null;
  startSellingUrl: string | null;
  isStartSellingEnable: boolean | null;
  returnRate: string | null;
  returnRateColor: string | null;
  topReturnReasons: ReturnReason[];

  /** The first/default product image on the product page. */
  mainImage?: string | null;
  /** Product title as shown on the product page. */
  title?: string | null;

  // ---- job bookkeeping ----
  /** Flipkart product id from the listing card. */
  pid: string;
  /** Product-details URL that was scraped. */
  url: string;
  /** 1-based listing page this product came from. */
  page: number;
  /** 1-based slot within that listing page. */
  productIndex: number;
  /** ISO timestamp of when the row was persisted. */
  scrapedAt: string;
  /** Wall-clock ms the scrape of this single product took. */
  durationMs: number;
  /** Error text when success is false (kept so the table can show it). */
  error: string | null;
}

/** Where in the pipeline a product failed. Drives the error classifier. */
export type FailureStage =
  | "listing"
  | "navigation"
  | "extension"
  | "panel"
  | "fsn"
  | "extraction"
  | "unknown";

/** Normalised failure reason. Never "something went wrong". */
export type ErrorType =
  | "Navigation Timeout"
  | "Selector Not Found"
  | "Seller Lens Data Missing"
  | "Extension Not Loaded"
  | "Network Error"
  | "Browser Closed"
  | "Context Closed"
  | "Page Crash"
  | "Captcha"
  | "Product Removed"
  | "Unexpected Popup"
  | "JavaScript Exception"
  | "Clipboard Empty"
  | "Unknown Error";

export type FailureStatus = "failed" | "retrying" | "resolved";

/** One persisted failure row. */
export interface FailureRecord {
  /** Stable id so retry/dedupe can address a single failure: `${page}:${pid|index}`. */
  id: string;
  fsn: string | null;
  pid: string;
  url: string;
  page: number;
  productIndex: number;
  failedAt: string;
  stage: FailureStage;
  errorType: ErrorType;
  message: string;
  stack: string | null;
  retryCount: number;
  status: FailureStatus;
  /** Path (relative to the data dir) of the failure screenshot, if captured. */
  screenshot: string | null;
}
