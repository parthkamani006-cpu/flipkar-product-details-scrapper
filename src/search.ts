import type { BrowserContext, Page } from "playwright";
import {
  launchWithSellerLens,
  scrapeProductOnPage,
  type FSNResult,
  type ScrapeOptions,
} from "./sellerLens.js";
import { humanBehavior } from "./utils/humanBehavior.js";

/** Flipkart home page — the search always starts here. */
const FLIPKART_HOME = "https://www.flipkart.com/";

/**
 * The homepage search box (see main-flipkart-page.html):
 *   <input class="nw1UBF v1zwn25" type="text" name="q"
 *          title="Search for Products, Brands and More" ...>
 * The markup renders TWO of these (the second is a readonly clone used by the
 * sticky header), so we match by the stable `name="q"` + not-readonly rather
 * than by the rotating class names.
 */
const SEARCH_BOX = 'input[name="q"]:not([readonly])';

/** One product as found on a listing page. */
export interface ListingProduct {
  /** Flipkart product id (the card's data-id / the `pid` query param). */
  pid: string;
  /** Absolute product-details URL. */
  url: string;
}

/** A scraped product: the existing scraper's JSON plus listing context. */
export interface ScrapedProduct extends FSNResult {
  pid: string;
  url: string;
  page: number;
}

export interface SearchScrapeOptions extends ScrapeOptions {
  /** Keyword typed into the Flipkart search box (e.g. "scar tape"). */
  keyword: string;
  /**
   * Page numbers are 1-based and the range is EXCLUSIVE of startPage:
   * scraping runs over pages (startPage + 1) .. endPage.
   *   startPage=0, endPage=2 -> pages 1, 2
   *   startPage=5, endPage=8 -> pages 6, 7, 8
   */
  startPage: number;
  endPage: number;
}

/** Log a progress line to stderr so stdout stays machine-readable JSON. */
function log(message: string): void {
  console.error(message);
}

/**
 * Open the Flipkart homepage, type the keyword into the search box and submit.
 * @returns the resulting listing-page URL.
 */
export async function searchFlipkart(page: Page, keyword: string): Promise<string> {
  log("Opening Flipkart...");
  await page.goto(FLIPKART_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Flipkart sometimes throws a login modal over the homepage; Escape closes it
  // so it cannot swallow the click on the search box. Best-effort.
  await page.keyboard.press("Escape").catch(() => {});

  log(`Searching: ${keyword}`);
  const box = page.locator(SEARCH_BOX).first();
  await box.waitFor({ state: "visible", timeout: 30_000 });
  // fill() focuses the input itself. We deliberately do NOT click first: the
  // Seller Lens overlay (<plasmo-csui id="fk-seller-lens-host">) covers the
  // header and intercepts pointer events on the homepage.
  await box.fill(keyword);

  // Submitting navigates to /search?q=... — wait for that navigation explicitly.
  // waitUntil "commit" (not the default "load"): the listing page keeps loading
  // lazy assets long after it is usable, so "load" can outlive the timeout.
  await Promise.all([
    page.waitForURL(/\/search\?/, { timeout: 60_000, waitUntil: "commit" }),
    box.press("Enter"),
  ]);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  return page.url();
}

/**
 * Build the URL for a given 1-based listing page number from the URL Flipkart
 * produced for the search. Pagination on the listing page is plain
 * `?...&page=N` links (see products-listing.html), so rewriting the query param
 * is equivalent to clicking "Next" — and immune to stale pagination elements.
 */
export function listingPageUrl(searchUrl: string, pageNumber: number): string {
  const u = new URL(searchUrl);
  u.searchParams.set("page", String(pageNumber));
  return u.toString();
}

/**
 * Collect every product card on the current listing page, in DOM order.
 *
 * Cards render as `<div data-id="<pid>">` wrapping an `<a href="/...-/p/itm...">`.
 * We read the pid from `data-id` (falling back to the `pid` query param) and
 * dedupe on it, because each card contains several anchors pointing at the same
 * product (image, title, price).
 */
export async function collectProductsOnPage(page: Page): Promise<ListingProduct[]> {
  // Cards hydrate lazily; wait for at least one before reading.
  await page
    .locator('div[data-id] a[href*="/p/"]')
    .first()
    .waitFor({ state: "attached", timeout: 30_000 })
    .catch(() => {});

  return page.evaluate(() => {
    const pidOf = (href: string): string | null => {
      try {
        return new URL(href, location.origin).searchParams.get("pid");
      } catch {
        return null;
      }
    };

    const out: { pid: string; url: string }[] = [];
    const seen = new Set<string>();

    const push = (pid: string | null, href: string): void => {
      const key = pid ?? href;
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ pid: pid ?? "", url: new URL(href, location.origin).toString() });
    };

    // Preferred: the card wrapper carries the product id on data-id.
    for (const card of Array.from(document.querySelectorAll<HTMLElement>("div[data-id]"))) {
      const link = card.querySelector<HTMLAnchorElement>('a[href*="/p/"]');
      if (!link) continue;
      push(card.dataset.id ?? pidOf(link.getAttribute("href") ?? ""), link.getAttribute("href")!);
    }

    // Fallback for layouts without data-id wrappers: every product anchor.
    if (out.length === 0) {
      for (const link of Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/itm"]'),
      )) {
        const href = link.getAttribute("href") ?? "";
        push(pidOf(href), href);
      }
    }

    return out;
  });
}

/**
 * Full flow: search Flipkart, walk the requested listing pages, and run the
 * EXISTING product-details scraper on every product — all inside one browser
 * session. A product that fails is logged and skipped; the run continues.
 */
export async function scrapeSearchResults(
  opts: SearchScrapeOptions,
): Promise<ScrapedProduct[]> {
  const firstPage = Math.max(1, Math.floor(opts.startPage) + 1);
  const lastPage = Math.floor(opts.endPage);
  if (lastPage < firstPage) {
    throw new Error(
      `Nothing to scrape: startPage=${opts.startPage} / endPage=${opts.endPage} ` +
        `resolves to pages ${firstPage}..${lastPage}.`,
    );
  }

  const scrapeOptions: ScrapeOptions = { ...opts };

  const results: ScrapedProduct[] = [];
  let context: BrowserContext | undefined;

  try {
    // ONE browser + ONE page for the whole run — reused for the listing and for
    // every product page.
    context = await launchWithSellerLens(opts);
    const page = context.pages()[0] ?? (await context.newPage());

    const searchUrl = await searchFlipkart(page, opts.keyword);

    // Products already scraped, so a product repeated across pages is only done once.
    const done = new Set<string>();

    for (let pageNo = firstPage; pageNo <= lastPage; pageNo++) {
      const listingUrl = listingPageUrl(searchUrl, pageNo);
      log(`\nOpening page ${pageNo}`);
      await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

      const products = await collectProductsOnPage(page);
      if (products.length === 0) {
        log(`No products found on page ${pageNo} — stopping.`);
        break;
      }
      log(`Found ${products.length} products on page ${pageNo}`);

      for (let i = 0; i < products.length; i++) {
        const product = products[i]!;
        const label = `Product ${i + 1}/${products.length}`;

        if (product.pid && done.has(product.pid)) {
          log(`${label} — already scraped (${product.pid}), skipping duplicate`);
          continue;
        }

        log(`${label}`);
        let result: FSNResult;
        try {
          // The existing product-details scraper, unchanged — just handed the
          // already-open context/page instead of launching its own browser.
          result = await scrapeProductOnPage(context, page, product.url, scrapeOptions);
        } catch (err) {
          // scrapeProductOnPage is already non-throwing; this is belt-and-braces
          // so a surprise (e.g. a closed page) still cannot kill the run.
          result = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          } as FSNResult;
        }

        if (result.success) {
          log("Scraped Successfully");
        } else {
          log(`Failed: ${result.error ?? "unknown error"} — continuing`);
        }

        if (product.pid) done.add(product.pid);
        results.push({ ...result, pid: product.pid, url: product.url, page: pageNo });

        // Back to the listing before the next product. Product links are stored
        // as plain URL strings (re-read from the DOM on every listing load), so
        // there are no stale element handles to go bad.
        await page
          .goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
          .catch((err: unknown) => log(`Could not return to listing: ${String(err)}`));

        // Idle like a human on the listing before opening the next product.
        // Purely cosmetic — never clicks or navigates, and cannot throw.
        if (i < products.length - 1) await humanBehavior(page);
      }

      if (pageNo < lastPage) log(`\nMoving to page ${pageNo + 1}`);
    }

    return results;
  } finally {
    await context?.close();
  }
}
