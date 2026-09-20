import type { BrowserContext, Page } from "playwright";
// The EXISTING scraper, imported and called unchanged.
import { scrapeProductOnPage, type FSNResult, type ScrapeOptions } from "../sellerLens.js";
import { classifyError, describeError } from "../errors/classify.js";
import { captureFailureScreenshot } from "../errors/screenshot.js";
import { logger } from "../logger/logger.js";
import { LogEvent } from "../logger/events.js";
import { failureId, type FailureStore } from "../storage/failureStore.js";
import { toProductRecord, type ProductStore } from "../storage/productStore.js";
import type { FailureRecord, ProductRecord } from "../storage/types.js";

export interface ProductTaskContext {
  pid: string;
  url: string;
  page: number;
  productIndex: number;
}

export interface ProductTaskDeps {
  context: BrowserContext;
  page: Page;
  products: ProductStore;
  failures: FailureStore;
  scrapeOptions: ScrapeOptions;
}

export interface ProductTaskOutcome {
  record: ProductRecord;
  failure: FailureRecord | null;
}

/**
 * Scrape ONE product and persist the outcome immediately.
 *
 * This is the only place the management system calls into the scraper, and it
 * calls `scrapeProductOnPage` with exactly the arguments `search.ts` always
 * did — same context, same page, same URL, same options. No selector, no
 * extraction step and no timeout is altered here; we only observe the result.
 *
 * Persistence order is deliberate: the product row is written BEFORE anything
 * else, so a crash one instruction later still leaves the product recorded and
 * the resume still skips it.
 */
export async function scrapeAndPersist(
  deps: ProductTaskDeps,
  ctx: ProductTaskContext,
): Promise<ProductTaskOutcome> {
  const { context, page, products, failures, scrapeOptions } = deps;

  logger.info(LogEvent.PRODUCT_STARTED, `Product ${ctx.productIndex} on page ${ctx.page}`, {
    pid: ctx.pid,
    url: ctx.url,
    page: ctx.page,
    productIndex: ctx.productIndex,
  });

  const startedAt = Date.now();
  let result: FSNResult;
  try {
    // ---- THE EXISTING SCRAPER — unchanged call, unchanged behaviour ----
    result = await scrapeProductOnPage(context, page, ctx.url, scrapeOptions);
  } catch (err) {
    // scrapeProductOnPage is already non-throwing; this catches surprises like
    // a closed page so a single product can never kill the job.
    result = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    } as FSNResult;
  }
  const durationMs = Date.now() - startedAt;

  // ---- 1. persist the product row first (crash-safe append) ----
  const record = toProductRecord(result, { ...ctx, durationMs });
  products.save(record);

  if (record.success) {
    logger.info(LogEvent.PRODUCT_COMPLETED, `Scraped ${record.fsn ?? ctx.pid} in ${durationMs}ms`, {
      pid: ctx.pid,
      fsn: record.fsn,
      page: ctx.page,
      productIndex: ctx.productIndex,
      durationMs,
    });
    // A previously-failed product that now succeeded is no longer outstanding.
    const id = failureId(ctx.page, ctx.pid, ctx.url);
    if (failures.get(id)) failures.resolve(id);
    return { record, failure: null };
  }

  // ---- 2. failure path: classify, screenshot, persist the diagnostic row ----
  const classified = classifyError(record.error, "unknown");
  const screenshot = await captureFailureScreenshot(page, ctx);
  if (screenshot) {
    logger.info(LogEvent.SCREENSHOT_SAVED, `Saved failure screenshot ${screenshot}`, {
      pid: ctx.pid,
      screenshot,
    });
  }

  const failure = failures.save({
    id: failureId(ctx.page, ctx.pid, ctx.url),
    fsn: record.fsn,
    pid: ctx.pid,
    url: ctx.url,
    page: ctx.page,
    productIndex: ctx.productIndex,
    failedAt: new Date().toISOString(),
    stage: classified.stage,
    errorType: classified.errorType,
    message: classified.message,
    stack: classified.stack,
    status: "failed",
    screenshot,
  });

  logger.error(LogEvent.PRODUCT_FAILED, describeError(classified), {
    pid: ctx.pid,
    page: ctx.page,
    productIndex: ctx.productIndex,
    errorType: classified.errorType,
    stage: classified.stage,
    retryCount: failure.retryCount,
    screenshot,
  });

  return { record, failure };
}
