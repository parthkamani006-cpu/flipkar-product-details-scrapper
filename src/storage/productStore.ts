import type { FSNResult } from "../sellerLens.js";
import { PRODUCTS_FILE } from "../utils/paths.js";
import { JsonlStore } from "./jsonlStore.js";
import type { ProductRecord } from "./types.js";

/** Dedupe key: pid when Flipkart gave us one, else the URL. */
function keyOf(row: { pid: string; url: string }): string {
  return row.pid || row.url;
}

/**
 * Adapt one result from the EXISTING scraper into a persisted row.
 *
 * This is the single place the scraper's shape meets ours. It copies the
 * scraped fields verbatim and performs the one agreed rename
 * (`isStartSellingUrlEnable` -> `isStartSellingEnable`); the scraper itself is
 * never touched.
 */
export function toProductRecord(
  result: FSNResult,
  context: { pid: string; url: string; page: number; productIndex: number; durationMs: number },
): ProductRecord {
  return {
    success: result.success,
    fsn: result.fsn ?? null,
    price: result.price,
    rating: result.rating,
    reviewCount: result.reviewCount,
    returnPolicy: result.returnPolicy,
    conversionFunnel: result.conversionFunnel,
    salesRank: result.salesRank,
    quality: result.quality,
    latchOnUrl: result.latchOnUrl,
    startSellingUrl: result.startSellingUrl,
    isStartSellingEnable: result.isStartSellingUrlEnable,
    returnRate: result.returnRate,
    returnRateColor: result.returnRateColor,
    topReturnReasons: result.topReturnReasons ?? [],

    // Product image + title, read off the product page alongside every other
    // field. Absent only when the page could not be read at all.
    ...(result.mainImage !== undefined ? { mainImage: result.mainImage } : {}),
    ...(result.title !== undefined ? { title: result.title } : {}),

    pid: context.pid,
    url: context.url,
    page: context.page,
    productIndex: context.productIndex,
    scrapedAt: new Date().toISOString(),
    durationMs: context.durationMs,
    error: result.success ? null : (result.error ?? "Unknown Error"),
  };
}

/** Durable, append-per-product store of every scraped product. */
export class ProductStore {
  private readonly store = new JsonlStore<ProductRecord>(PRODUCTS_FILE, keyOf);

  /** Persist one product to disk immediately. */
  save(record: ProductRecord): void {
    this.store.append(record);
  }

  all(): readonly ProductRecord[] {
    return this.store.all();
  }

  /** Rows belonging to one listing page, in scrape order. */
  byPage(pageNo: number): ProductRecord[] {
    return this.store.all().filter((r) => r.page === pageNo);
  }

  /**
   * Has this product already been scraped? This — not the checkpoint — is the
   * authority on "already done", so a resume can never re-scrape a product.
   */
  hasProduct(pid: string, url: string): boolean {
    return this.store.has(keyOf({ pid, url }));
  }

  get(pid: string, url: string): ProductRecord | undefined {
    return this.store.get(keyOf({ pid, url }));
  }

  counts(): { total: number; success: number; failed: number } {
    let success = 0;
    for (const row of this.store.all()) if (row.success) success++;
    const total = this.store.count();
    return { total, success, failed: total - success };
  }

  clear(): void {
    this.store.clear();
  }
}
