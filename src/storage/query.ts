import { parsePercent, toNumberOrNull } from "../utils/format.js";
import type { ProductRecord } from "./types.js";

/**
 * Comparison for one conversion-funnel percentage: above / below / same as a
 * threshold. Deliberately not a min/max range — the funnel steps are read as
 * "is this rate better or worse than X", not as a band.
 */
export type FunnelOp = "gt" | "lt" | "eq";

export interface FunnelFilter {
  op: FunnelOp;
  value: number;
}

/** The three funnel steps, in funnel order. Shared by the parser and matcher. */
export const FUNNEL_STEPS = ["impressionToClick", "clickToCart", "cartToSale"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/**
 * Filter/sort/paginate spec for the product table.
 *
 * Covers the scalar fields plus the three `conversionFunnel` percentages, each
 * as a single above/below/equal comparison. `salesRank` and `topReturnReasons`
 * stay structured detail-panel data — not filterable and not sortable, by
 * design — which is what keeps the main grid compact and the query O(n).
 */
export interface ProductQuery {
  /** Free-text search across FSN / PID / URL. */
  search?: string;
  /** FSN match. `mode` picks contains (default) vs exact. */
  fsn?: string;
  fsnMode?: "contains" | "exact";

  priceMin?: number;
  priceMax?: number;
  ratingMin?: number;
  ratingMax?: number;
  reviewCountMin?: number;
  reviewCountMax?: number;
  /** Compared against the numeric part of returnRate ("3.1%" -> 3.1). */
  returnRateMin?: number;
  returnRateMax?: number;

  /** Conversion-funnel comparisons. Absent key = that step is unfiltered. */
  impressionToClick?: FunnelFilter;
  clickToCart?: FunnelFilter;
  cartToSale?: FunnelFilter;

  /** Multi-select: a row matches if its value is in the list. */
  quality?: string[];
  returnPolicy?: string[];
  returnRateColor?: string[];
  page?: number[];

  /** Tri-state: true / false / null (no button found). */
  isStartSellingEnable?: ("true" | "false" | "null")[];
  /** Row status multi-select. */
  success?: ("true" | "false")[];

  sortBy?: keyof ProductRecord;
  sortDir?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

export interface QueryResult {
  rows: ProductRecord[];
  /** Rows matching the filters, before paging. */
  total: number;
  /** Rows in the store, before filtering. */
  unfiltered: number;
}

/** Fields the UI is allowed to sort by — everything scalar. */
const SORTABLE = new Set<keyof ProductRecord>([
  "fsn",
  "price",
  "rating",
  "reviewCount",
  "returnPolicy",
  "quality",
  "returnRate",
  "returnRateColor",
  "isStartSellingEnable",
  "success",
  "page",
  "productIndex",
  "scrapedAt",
  "durationMs",
]);

function inList(value: string | null, list: string[] | undefined): boolean {
  if (!list || list.length === 0) return true;
  return list.includes(value ?? "");
}

function withinRange(value: number | null, min?: number, max?: number): boolean {
  if (min === undefined && max === undefined) return true;
  // A row with no value cannot satisfy a numeric bound — exclude it, otherwise
  // "price >= 500" would quietly include price-less rows.
  if (value === null) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

/**
 * Percentages are stored to two decimals, so exact equality is compared with a
 * tolerance rather than `===` — "same as 45.33" must match a stored 45.33.
 */
const FUNNEL_EPSILON = 1e-6;

function matchesFunnel(value: number | null | undefined, filter?: FunnelFilter): boolean {
  if (!filter) return true;
  // Same rule as the numeric ranges: a row without funnel data cannot satisfy
  // a funnel bound, so "Cart to Sale above 50" never smuggles in blank rows.
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  if (filter.op === "gt") return value > filter.value;
  if (filter.op === "lt") return value < filter.value;
  return Math.abs(value - filter.value) <= FUNNEL_EPSILON;
}

/** Sort key for tri-state booleans so null always sorts last. */
function boolKey(value: boolean | null): number {
  if (value === true) return 2;
  if (value === false) return 1;
  return 0;
}

function compare(a: ProductRecord, b: ProductRecord, field: keyof ProductRecord): number {
  if (field === "returnRate") {
    const x = parsePercent(a.returnRate);
    const y = parsePercent(b.returnRate);
    return (x ?? -1) - (y ?? -1);
  }
  if (field === "isStartSellingEnable") {
    return boolKey(a.isStartSellingEnable) - boolKey(b.isStartSellingEnable);
  }

  const x = a[field];
  const y = b[field];

  // Nulls always sort to the end of an ascending sort.
  if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
  if (y === null || y === undefined) return -1;

  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "boolean" && typeof y === "boolean") return Number(x) - Number(y);
  return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
}

/** Apply a query to the in-memory rows. Pure — never mutates the input. */
export function queryProducts(
  all: readonly ProductRecord[],
  q: ProductQuery,
): QueryResult {
  const search = q.search?.trim().toLowerCase();
  const fsnTerm = q.fsn?.trim().toLowerCase();

  const filtered = all.filter((row) => {
    if (search) {
      const haystack = `${row.fsn ?? ""} ${row.pid} ${row.url}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    if (fsnTerm) {
      const value = (row.fsn ?? "").toLowerCase();
      if (q.fsnMode === "exact" ? value !== fsnTerm : !value.includes(fsnTerm)) return false;
    }

    if (!withinRange(row.price, q.priceMin, q.priceMax)) return false;
    if (!withinRange(row.rating, q.ratingMin, q.ratingMax)) return false;
    if (!withinRange(row.reviewCount, q.reviewCountMin, q.reviewCountMax)) return false;
    if (!withinRange(parsePercent(row.returnRate), q.returnRateMin, q.returnRateMax)) return false;

    const funnel = row.conversionFunnel;
    if (!matchesFunnel(funnel?.impressionToClick, q.impressionToClick)) return false;
    if (!matchesFunnel(funnel?.clickToCart, q.clickToCart)) return false;
    if (!matchesFunnel(funnel?.cartToSale, q.cartToSale)) return false;

    if (!inList(row.quality, q.quality)) return false;
    if (!inList(row.returnPolicy, q.returnPolicy)) return false;
    if (!inList(row.returnRateColor, q.returnRateColor)) return false;

    if (q.page && q.page.length > 0 && !q.page.includes(row.page)) return false;

    if (q.isStartSellingEnable && q.isStartSellingEnable.length > 0) {
      const key = row.isStartSellingEnable === null ? "null" : String(row.isStartSellingEnable);
      if (!q.isStartSellingEnable.includes(key as "true" | "false" | "null")) return false;
    }

    if (q.success && q.success.length > 0) {
      if (!q.success.includes(String(row.success) as "true" | "false")) return false;
    }

    return true;
  });

  const sortBy = q.sortBy && SORTABLE.has(q.sortBy) ? q.sortBy : undefined;
  if (sortBy) {
    const dir = q.sortDir === "desc" ? -1 : 1;
    filtered.sort((a, b) => compare(a, b, sortBy) * dir);
  }

  const offset = Math.max(0, q.offset ?? 0);
  const limit = q.limit === undefined ? filtered.length : Math.max(0, q.limit);

  return {
    rows: filtered.slice(offset, offset + limit),
    total: filtered.length,
    unfiltered: all.length,
  };
}

/**
 * Distinct values for the multi-select filters, derived from the data actually
 * present so the UI never offers a value that matches nothing.
 */
export function filterOptions(all: readonly ProductRecord[]): {
  quality: string[];
  returnPolicy: string[];
  returnRateColor: string[];
  pages: number[];
} {
  const quality = new Set<string>();
  const returnPolicy = new Set<string>();
  const returnRateColor = new Set<string>();
  const pages = new Set<number>();

  for (const row of all) {
    if (row.quality) quality.add(row.quality);
    if (row.returnPolicy) returnPolicy.add(row.returnPolicy);
    if (row.returnRateColor) returnRateColor.add(row.returnRateColor);
    pages.add(row.page);
  }

  const sorted = (s: Set<string>): string[] => [...s].sort((a, b) => a.localeCompare(b));
  return {
    quality: sorted(quality),
    returnPolicy: sorted(returnPolicy),
    returnRateColor: sorted(returnRateColor),
    pages: [...pages].sort((a, b) => a - b),
  };
}

/** Build a ProductQuery from an Express query object (all values are strings). */
export function parseQuery(raw: Record<string, unknown>): ProductQuery {
  const str = (key: string): string | undefined => {
    const v = raw[key];
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  const num = (key: string): number | undefined => toNumberOrNull(raw[key]) ?? undefined;
  const list = (key: string): string[] | undefined => {
    const v = raw[key];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "string" && v.trim() !== "") return v.split(",").map((s) => s.trim());
    return undefined;
  };

  /**
   * `<step>Op` + `<step>Value` — e.g. `cartToSaleOp=gt&cartToSaleValue=50`.
   * Both must be present and valid, otherwise the step stays unfiltered.
   */
  const funnel = (step: FunnelStep): FunnelFilter | undefined => {
    const op = str(`${step}Op`);
    const value = num(`${step}Value`);
    if (op !== "gt" && op !== "lt" && op !== "eq") return undefined;
    if (value === undefined || !Number.isFinite(value)) return undefined;
    return { op, value };
  };

  return {
    search: str("search"),
    fsn: str("fsn"),
    fsnMode: str("fsnMode") === "exact" ? "exact" : "contains",
    priceMin: num("priceMin"),
    priceMax: num("priceMax"),
    ratingMin: num("ratingMin"),
    ratingMax: num("ratingMax"),
    reviewCountMin: num("reviewCountMin"),
    reviewCountMax: num("reviewCountMax"),
    returnRateMin: num("returnRateMin"),
    returnRateMax: num("returnRateMax"),
    impressionToClick: funnel("impressionToClick"),
    clickToCart: funnel("clickToCart"),
    cartToSale: funnel("cartToSale"),
    quality: list("quality"),
    returnPolicy: list("returnPolicy"),
    returnRateColor: list("returnRateColor"),
    page: list("page")?.map(Number).filter(Number.isFinite),
    isStartSellingEnable: list("isStartSellingEnable") as ProductQuery["isStartSellingEnable"],
    success: list("success") as ProductQuery["success"],
    sortBy: str("sortBy") as keyof ProductRecord | undefined,
    sortDir: str("sortDir") === "desc" ? "desc" : "asc",
    offset: num("offset"),
    limit: num("limit"),
  };
}
