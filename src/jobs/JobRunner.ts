import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright";

// ---- EXISTING scraper primitives, imported and composed unchanged ----
import { launchWithSellerLens, type ScrapeOptions } from "../sellerLens.js";
import { collectProductsOnPage, listingPageUrl, searchFlipkart } from "../search.js";

import { CheckpointStore } from "../checkpoint/checkpointStore.js";
import { classifyError, describeError } from "../errors/classify.js";
import { exportAll, exportPage } from "../excel/exporters.js";
import { LogEvent } from "../logger/events.js";
import { logger } from "../logger/logger.js";
import { FailureStore } from "../storage/failureStore.js";
import { ProductStore } from "../storage/productStore.js";
import type { FailureRecord, ProductRecord } from "../storage/types.js";
import { humanBehavior } from "../utils/humanBehavior.js";
import { ensureDirs } from "../utils/paths.js";
import {
  ControlGate,
  RateTracker,
  Stopwatch,
  StopSignal,
  type JobStats,
  type JobStatus,
} from "./jobState.js";
import { scrapeAndPersist } from "./productTask.js";

export interface StartOptions {
  keyword: string;
  /** Exclusive lower bound, matching the existing CLI: 0 => start at page 1. */
  startPage: number;
  /** Inclusive upper bound. */
  endPage: number;
  /** Wipe products/failures/checkpoint and start from scratch. */
  fresh?: boolean;
  headless?: boolean;
  captureLatchOn?: boolean;
}

/**
 * Orchestrates a long-running scrape around the EXISTING scraper.
 *
 * It reimplements only the *loop* (search -> pages -> products) using the same
 * exported primitives `search.ts` uses, so it can interleave persistence,
 * checkpointing, pause/stop and live events between products. The product
 * scrape itself is delegated verbatim to `scrapeProductOnPage`.
 *
 * Emits: "stats" | "product" | "failure" | "export" | "status".
 */
export class JobRunner extends EventEmitter {
  readonly products = new ProductStore();
  readonly failures = new FailureStore();
  readonly checkpoint = new CheckpointStore();

  private readonly gate = new ControlGate();
  private readonly rate = new RateTracker();
  private readonly stopwatch: Stopwatch;

  private status: JobStatus = "idle";
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private active: Promise<void> | null = null;

  /** Products counted per visited page — feeds the total estimate. */
  private productsPerPage: Record<string, number>;

  constructor() {
    super();
    ensureDirs();
    const saved = this.checkpoint.get();
    this.stopwatch = new Stopwatch(saved.elapsedMs);
    this.productsPerPage = { ...saved.productsPerPage };
    // A checkpoint left in "running" means the process died mid-job.
    if (saved.status === "running") {
      this.status = "paused";
      logger.warn(
        LogEvent.JOB_PAUSED,
        "Found an interrupted job from a previous run — press Resume to continue.",
        { keyword: saved.keyword, currentPage: saved.currentPage },
      );
    } else if (saved.status !== "idle") {
      this.status = saved.status;
    }
  }

  // ------------------------------------------------------------------
  // public control surface
  // ------------------------------------------------------------------

  isBusy(): boolean {
    return this.status === "starting" || this.status === "running" || this.status === "stopping";
  }

  /** Whether a previous run left something to resume. */
  canResume(): boolean {
    const cp = this.checkpoint.get();
    return (
      !this.isBusy() &&
      cp.keyword !== "" &&
      (this.status === "paused" || this.status === "stopped" || cp.status === "running")
    );
  }

  /** Begin a new job. Returns once the job has been kicked off, not finished. */
  start(options: StartOptions): void {
    if (this.isBusy()) throw new Error(`Cannot start: job is ${this.status}.`);
    if (!options.keyword.trim()) {
      throw new Error("A search keyword is required.");
    }
    if (options.endPage < options.startPage + 1) {
      throw new Error(
        `Nothing to scrape: startPage=${options.startPage} / endPage=${options.endPage}.`,
      );
    }

    if (options.fresh) {
      this.products.clear();
      this.failures.clear();
      this.checkpoint.reset();
      this.productsPerPage = {};
      this.rate.reset();
      this.stopwatch.reset(0);
    }

    this.checkpoint.update({
      jobId: `job-${Date.now()}`,
      keyword: options.keyword,
      startPage: options.startPage,
      endPage: options.endPage,
      searchUrl: options.fresh ? null : this.checkpoint.get().searchUrl,
      startedAt: new Date().toISOString(),
      status: "running",
    });

    logger.info(LogEvent.JOB_STARTED, `Job started for "${options.keyword}"`, {
      startPage: options.startPage,
      endPage: options.endPage,
      fresh: Boolean(options.fresh),
    });

    this.active = this.run(options, false);
  }

  /** Continue exactly where the last execution stopped. */
  resume(): void {
    // Resuming from a pause inside a live job just opens the gate.
    if (this.status === "paused" && this.active) {
      this.gate.resume();
      this.setStatus("running");
      this.stopwatch.start();
      this.checkpoint.update({ status: "running" });
      logger.info(LogEvent.JOB_RESUMED, "Job resumed.");
      return;
    }

    if (this.isBusy()) throw new Error(`Cannot resume: job is ${this.status}.`);

    const cp = this.checkpoint.get();
    if (!cp.keyword) throw new Error("Nothing to resume — no previous job found.");

    logger.info(LogEvent.JOB_RESUMED, `Resuming "${cp.keyword}" from page ${cp.currentPage ?? "?"}`, {
      completedProducts: this.products.counts().total,
      completedPages: cp.completedPages,
    });

    this.checkpoint.update({ status: "running" });
    this.active = this.run(
      { keyword: cp.keyword, startPage: cp.startPage, endPage: cp.endPage },
      true,
    );
  }

  /** Pause at the next product boundary. */
  pause(): void {
    if (this.status !== "running" && this.status !== "starting") {
      throw new Error(`Cannot pause: job is ${this.status}.`);
    }
    this.gate.pause();
    this.setStatus("paused");
    this.stopwatch.stop();
    this.checkpoint.update({ status: "paused", elapsedMs: this.stopwatch.elapsedMs() });
    logger.info(LogEvent.JOB_PAUSED, "Job paused — will stop after the current product.");
  }

  /** Stop the job and close the browser. Progress stays resumable. */
  stop(): void {
    if (!this.isBusy() && this.status !== "paused") {
      throw new Error(`Cannot stop: job is ${this.status}.`);
    }
    this.gate.stop();

    // A job restored as "paused" from a previous run has no live loop to catch
    // the StopSignal, so it would otherwise sit in "stopping" forever and block
    // every future Start. With nothing running, settle straight to "stopped".
    if (!this.active) {
      this.finish("stopped");
      return;
    }

    this.setStatus("stopping");
    logger.info(LogEvent.JOB_STOPPED, "Stop requested — finishing the current product.");
  }

  // ------------------------------------------------------------------
  // the scrape loop
  // ------------------------------------------------------------------

  private async run(options: StartOptions, isResume: boolean): Promise<void> {
    this.gate.reset();
    this.setStatus("starting");
    this.stopwatch.start();
    this.startTicker();

    const scrapeOptions: ScrapeOptions = {
      headless: options.headless ?? resolveHeadless(),
      captureLatchOn: options.captureLatchOn !== false,
    };

    const firstPage = Math.max(1, Math.floor(options.startPage) + 1);
    const lastPage = Math.floor(options.endPage);

    try {
      this.context = await launchWithSellerLens(scrapeOptions);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      logger.info(LogEvent.BROWSER_LAUNCHED, "Browser launched with Seller Lens.", {
        headless: scrapeOptions.headless,
      });

      // On resume we reuse the search URL captured last time, so we do not have
      // to re-run the homepage search flow at all.
      const saved = this.checkpoint.get().searchUrl;
      let searchUrl: string;
      if (isResume && saved) {
        searchUrl = saved;
        logger.info(LogEvent.SEARCH_SUBMITTED, "Reusing saved search URL from checkpoint.", {
          searchUrl,
        });
      } else {
        searchUrl = await searchFlipkart(this.page, options.keyword);
        this.checkpoint.update({ searchUrl });
        logger.info(LogEvent.SEARCH_SUBMITTED, `Search submitted for "${options.keyword}".`, {
          searchUrl,
        });
      }

      this.setStatus("running");

      for (let pageNo = firstPage; pageNo <= lastPage; pageNo++) {
        await this.gate.gate();

        if (this.checkpoint.isPageComplete(pageNo)) {
          logger.info(LogEvent.PAGE_SKIPPED, `Page ${pageNo} already completed — skipping.`, {
            page: pageNo,
          });
          continue;
        }

        const done = await this.runPage(pageNo, searchUrl, scrapeOptions);
        if (!done) break; // empty listing page — nothing further to scrape
      }

      this.finish("completed");
    } catch (err) {
      if (err instanceof StopSignal) {
        this.finish("stopped");
      } else {
        const classified = classifyError(err, "listing");
        logger.error(LogEvent.JOB_FAILED, describeError(classified), {
          errorType: classified.errorType,
          stack: classified.stack,
        });
        this.finish("failed");
      }
    } finally {
      await this.closeBrowser();
      this.stopTicker();
      this.emitStats();
      this.active = null;
    }
  }

  /**
   * Scrape one listing page end to end.
   * @returns false when the page had no products (the run should stop).
   */
  private async runPage(
    pageNo: number,
    searchUrl: string,
    scrapeOptions: ScrapeOptions,
  ): Promise<boolean> {
    const page = this.page!;
    const listingUrl = listingPageUrl(searchUrl, pageNo);

    logger.info(LogEvent.PAGE_STARTED, `Opening listing page ${pageNo}`, { page: pageNo, listingUrl });
    this.checkpoint.update({ currentPage: pageNo, currentProduct: null });

    await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const listing = await collectProductsOnPage(page);

    if (listing.length === 0) {
      logger.warn(LogEvent.PAGE_COMPLETED, `No products found on page ${pageNo} — stopping.`, {
        page: pageNo,
      });
      return false;
    }

    this.productsPerPage[String(pageNo)] = listing.length;
    this.checkpoint.update({ productsPerPage: this.productsPerPage });
    logger.info(LogEvent.PAGE_STARTED, `Found ${listing.length} products on page ${pageNo}`, {
      page: pageNo,
      products: listing.length,
    });
    this.emitStats();

    for (let i = 0; i < listing.length; i++) {
      await this.gate.gate();

      const product = listing[i]!;
      const productIndex = i + 1;

      // The product store — not the checkpoint — decides what is already done,
      // so a resume can never re-scrape a product even if the checkpoint is
      // one product stale. This also dedupes products repeated across pages.
      if (this.products.hasProduct(product.pid, product.url)) {
        logger.info(
          LogEvent.PRODUCT_SKIPPED,
          `Product ${productIndex}/${listing.length} already scraped — skipping.`,
          { page: pageNo, productIndex, pid: product.pid },
        );
        continue;
      }

      this.checkpoint.update({
        currentPage: pageNo,
        currentProduct: productIndex,
        currentProductLabel: product.pid || product.url,
      });

      const outcome = await scrapeAndPersist(
        {
          context: this.context!,
          page,
          products: this.products,
          failures: this.failures,
          scrapeOptions,
        },
        { pid: product.pid, url: product.url, page: pageNo, productIndex },
      );

      this.rate.record();
      this.persistCounts();
      this.emit("product", outcome.record satisfies ProductRecord);
      if (outcome.failure) this.emit("failure", outcome.failure satisfies FailureRecord);
      this.emitStats();

      // Return to the listing between products — same as the existing flow.
      await page
        .goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
        .catch((err: unknown) => {
          logger.warn(LogEvent.PAGE_STARTED, `Could not return to listing: ${String(err)}`, {
            page: pageNo,
          });
        });

      // Idle like a human on the listing before opening the next product.
      // Purely cosmetic — never clicks or navigates, and cannot throw.
      if (i < listing.length - 1) await humanBehavior(page);
    }

    // ---- page complete: checkpoint, then export page-N.xlsx immediately ----
    this.checkpoint.markPageComplete(pageNo);
    logger.info(LogEvent.PAGE_COMPLETED, `Page ${pageNo} completed.`, { page: pageNo });

    try {
      const result = await exportPage(pageNo, this.products, this.checkpoint);
      this.emit("export", { page: pageNo, ...result });
    } catch (err) {
      // An export problem must never lose scraped data — the rows are already
      // on disk and the workbook can be regenerated from the dashboard.
      logger.error(LogEvent.EXCEL_GENERATED, `Failed to write page-${pageNo}.xlsx: ${String(err)}`, {
        page: pageNo,
      });
    }

    this.emitStats();
    return true;
  }

  // ------------------------------------------------------------------
  // retry
  // ------------------------------------------------------------------

  /**
   * Re-scrape a specific set of failed products (or every outstanding failure
   * when `ids` is omitted). Runs the same per-product task, so a retry that
   * succeeds overwrites the stored row and resolves the failure.
   */
  async retry(ids?: string[]): Promise<{ attempted: number; recovered: number }> {
    if (this.isBusy()) throw new Error(`Cannot retry: job is ${this.status}.`);

    const targets = (ids && ids.length > 0
      ? ids.map((id) => this.failures.get(id)).filter((f): f is FailureRecord => Boolean(f))
      : this.failures.outstanding()
    ).filter((f) => f.status !== "resolved");

    if (targets.length === 0) return { attempted: 0, recovered: 0 };

    this.gate.reset();
    this.setStatus("running");
    this.stopwatch.start();
    this.startTicker();
    logger.info(LogEvent.RETRY_STARTED, `Retrying ${targets.length} failed product(s).`, {
      count: targets.length,
    });

    const scrapeOptions: ScrapeOptions = {
      headless: resolveHeadless(),
      captureLatchOn: true,
    };
    let recovered = 0;

    try {
      this.context = await launchWithSellerLens(scrapeOptions);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());

      for (const target of targets) {
        await this.gate.gate();
        this.failures.setStatus(target.id, "retrying");
        this.checkpoint.update({
          currentPage: target.page,
          currentProduct: target.productIndex,
          currentProductLabel: target.pid || target.url,
        });

        const outcome = await scrapeAndPersist(
          {
            context: this.context,
            page: this.page,
            products: this.products,
            failures: this.failures,
            scrapeOptions,
          },
          {
            pid: target.pid,
            url: target.url,
            page: target.page,
            productIndex: target.productIndex,
          },
        );

        if (outcome.record.success) recovered++;
        this.rate.record();
        this.persistCounts();
        this.emit("product", outcome.record);
        if (outcome.failure) this.emit("failure", outcome.failure);
        this.emitStats();
      }

      logger.info(
        LogEvent.RETRY_FINISHED,
        `Retry finished — ${recovered}/${targets.length} recovered.`,
        { attempted: targets.length, recovered },
      );
      return { attempted: targets.length, recovered };
    } catch (err) {
      if (!(err instanceof StopSignal)) {
        const classified = classifyError(err, "unknown");
        logger.error(LogEvent.RETRY_FINISHED, describeError(classified), {
          errorType: classified.errorType,
        });
      }
      return { attempted: targets.length, recovered };
    } finally {
      await this.closeBrowser();
      this.stopTicker();
      this.stopwatch.stop();
      this.setStatus("completed");
      this.emitStats();
    }
  }

  // ------------------------------------------------------------------
  // exports
  // ------------------------------------------------------------------

  /** Manual page export (the dashboard's "Export Current Page"). */
  async exportPageNow(pageNo: number): Promise<{ path: string; rows: number }> {
    const result = await exportPage(pageNo, this.products, this.checkpoint, { force: true });
    this.emit("export", { page: pageNo, ...result });
    return result;
  }

  /** Merge everything scraped so far into one workbook. */
  async exportAllNow(): Promise<{ path: string; rows: number }> {
    const result = await exportAll(this.products);
    this.emit("export", { page: null, ...result });
    return result;
  }

  // ------------------------------------------------------------------
  // stats
  // ------------------------------------------------------------------

  stats(): JobStats {
    const cp = this.checkpoint.get();
    const counts = this.products.counts();

    const firstPage = Math.max(1, Math.floor(cp.startPage) + 1);
    const lastPage = Math.floor(cp.endPage);
    const pageCount = Math.max(0, lastPage - firstPage + 1);

    // Known products = what we actually saw on visited pages. For pages not yet
    // visited we extrapolate from the average page size, and flag the total as
    // an estimate so the UI can say so.
    const visited = Object.keys(this.productsPerPage).length;
    const known = Object.values(this.productsPerPage).reduce((sum, n) => sum + n, 0);
    const averagePerPage = visited > 0 ? known / visited : 0;
    const unvisited = Math.max(0, pageCount - visited);
    const completed = counts.total;
    // The estimate can never be below what is already on disk — otherwise a
    // resumed job (whose per-page counts are only rebuilt as pages are
    // revisited) would report "24 completed of 0 total" at 0% progress.
    const totalProducts = Math.max(
      completed,
      visited === 0 ? 0 : Math.round(known + averagePerPage * unvisited),
    );
    const remaining = Math.max(0, totalProducts - completed);
    const runningTimeMs = this.stopwatch.elapsedMs();

    return {
      status: this.status,
      keyword: cp.keyword,
      startPage: cp.startPage,
      endPage: cp.endPage,
      totalProducts,
      totalIsEstimate: unvisited > 0,
      completedProducts: completed,
      remainingProducts: remaining,
      successCount: counts.success,
      failedCount: counts.failed,
      currentPage: cp.currentPage,
      currentProduct: cp.currentProduct,
      currentProductLabel: cp.currentProductLabel,
      completedPages: cp.completedPages,
      progressPercent:
        totalProducts > 0 ? Math.min(100, Math.round((completed / totalProducts) * 1000) / 10) : 0,
      runningTimeMs,
      estimatedRemainingMs: this.rate.estimateRemainingMs(remaining),
      productsPerMinute: Math.round(this.rate.perMinute() * 10) / 10,
      lastUpdated: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private persistCounts(): void {
    const counts = this.products.counts();
    this.checkpoint.update({
      completedProducts: counts.total,
      successCount: counts.success,
      failedCount: counts.failed,
      elapsedMs: this.stopwatch.elapsedMs(),
    });
    logger.log("debug", LogEvent.CHECKPOINT_SAVED, `Checkpoint saved (${counts.total} products).`, {
      completedProducts: counts.total,
    });
  }

  private setStatus(status: JobStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  private finish(status: JobStatus): void {
    this.stopwatch.stop();
    this.setStatus(status);
    this.checkpoint.update({
      status: status === "completed" ? "completed" : status === "stopped" ? "stopped" : "failed",
      elapsedMs: this.stopwatch.elapsedMs(),
      currentProduct: null,
    });
    const counts = this.products.counts();
    logger.info(LogEvent.JOB_FINISHED, `Job ${status} — ${counts.success} ok, ${counts.failed} failed.`, {
      status,
      ...counts,
    });
  }

  private async closeBrowser(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    await context?.close().catch(() => {});
  }

  /** Push a stats frame every second so timers tick even between products. */
  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => this.emitStats(), 1_000);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private emitStats(): void {
    this.emit("stats", this.stats());
  }
}

/** Same HEADLESS env contract as the existing CLI. */
function resolveHeadless(): boolean {
  const flag = (process.env.HEADLESS ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "no");
}
