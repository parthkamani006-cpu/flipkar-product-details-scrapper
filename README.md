# Flipkart Seller Lens → FSN scraper

Opens a Flipkart product page with the **Seller Lens** Chrome extension loaded,
clicks the **Copy FSN** button in the injected side panel, and returns the
copied FSN from the clipboard.

## Selector strategy

- Panel is located by the **stable** id `#fkSellerLensSidePanel` (open shadow DOM,
  pierced automatically by Playwright).
- The button is found by **role + visible text** (`Copy FSN`), never by the
  generated `sc-*` styled-components classes.

## Prerequisites

1. **Unpacked extension folder.** You need the Seller Lens extension on disk as an
   *unpacked* directory (the folder containing `manifest.json`). Extensions can
   only be loaded through a persistent Chromium context.
2. Node 18+.

## Install

```bash
npm install
npx playwright install chromium
```

## Configure

| Variable                    | Required | Purpose                                                        |
| --------------------------- | -------- | -------------------------------------------------------------- |
| `SELLER_LENS_PATH`          | yes      | Absolute path to the unpacked extension (contains manifest.json). |
| `SELLER_LENS_USER_DATA_DIR` | no       | Stable Chrome profile dir so onboarding/permissions persist.   |
| `HEADLESS`                  | no       | Headless is the **default**. Set `0` to watch the browser while debugging. |

### Headless by default

`npm start` runs the entire scrape in the background — no browser window, no
visible tabs, navigation, scrolling or clicking. This uses Chromium's *new*
headless mode (Playwright `channel: "chromium"`), which is a full browser
without a window, so the MV3 Seller Lens extension, its service worker and the
clipboard all work exactly as they do headed.

`npm run setup` still opens a real window on purpose — that step exists so you
can log in and grant the extension its permission interactively.

PowerShell example:

```powershell
$env:SELLER_LENS_PATH = "C:\path\to\seller-lens-unpacked"
# pass a specific product URL:
npm start -- "https://www.flipkart.com/.../p/itm...?pid=STIHNUAYF3J8ZGHZ"
```

## Search mode (keyword + pagination)

Instead of passing product URLs, you can give a **keyword**. The scraper opens
flipkart.com, types the keyword into the search box, then walks the requested
listing pages and runs the *same* product-details scraper on every product.

```powershell
npm start -- --search "scar tape" --start-page 0 --end-page 2
```

| Option         | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `--search`     | Keyword typed into the Flipkart search box (aliases: `--keyword`, `-s`). |
| `--start-page` | **Exclusive** lower bound. Defaults to `0`. Aliases: `--start`.      |
| `--end-page`   | **Inclusive** upper bound. Required. Aliases: `--end`.               |

Pages are 1-based and the range is `startPage + 1 … endPage`:

| Input                     | Pages scraped |
| ------------------------- | ------------- |
| `--start-page 0 --end-page 2` | 1, 2      |
| `--start-page 5 --end-page 8` | 6, 7, 8   |

Per page the scraper collects every product card, opens each product in turn,
runs the existing detail scraper, stores the JSON and returns to the listing
before the next one. **One browser session is reused for the whole run** — the
listing and every product share the same page, so Chromium is launched once.

Progress goes to **stderr**; the combined array of every scraped product is
written to **`result.json`** in the current directory. Each entry is the normal
product JSON plus `pid`, `url` and `page`.

A product that fails is logged (`Failed: …`) and skipped — the run continues.
Products repeated across listing pages are scraped only once (deduped by `pid`).

### How the pages are found

| Thing        | Selector / strategy                                                        |
| ------------ | -------------------------------------------------------------------------- |
| Search box   | `input[name="q"]:not([readonly])` — the page renders a readonly clone for the sticky header, and `name="q"` is stable where the classes rotate. |
| Product card | `div[data-id]` (the `data-id` **is** the product id/FSN) → first `a[href*="/p/"]` inside it; falls back to every `a[href*="/p/itm"]`, deduped by the `pid` query param. |
| Pagination   | The listing's own pager is plain `?…&page=N` links, so the page number is set on the search URL directly — equivalent to clicking *Next*, with no stale-element risk. |

## Output

The result includes the FSN plus extra product fields. Any field that cannot be
read comes back as `null` (individual fields never abort the run).

```json
{
  "success": true,
  "fsn": "STIHNUAYF3J8ZGHZ",
  "price": 200,
  "rating": 3.7,
  "reviewCount": 96,
  "returnPolicy": "No returns",
  "conversionFunnel": { "impressionToClick": 3.36, "clickToCart": 12.03, "cartToSale": 33.33 },
  "salesRank": [
    { "category": "Stickers And Wallpapers", "rank": 3196 },
    { "category": "Home Decor", "rank": 17636 },
    { "category": "Sticker", "rank": 2347 }
  ],
  "quality": "Good",
  "latchOnUrl": "https://sellerlens.flipkart.com/...",
  "startSellingUrl": "https://sellerlens.flipkart.com/...",
  "isStartSellingUrlEnable": true,
  "returnRate": "3.1%",
  "returnRateColor": "#22c55e",
  "topReturnReasons": [
    { "reason": "MISSHIPMENT", "percentage": 54 },
    { "reason": "MISSING ITEM", "percentage": 17 },
    { "reason": "DAMAGED PRODUCT", "percentage": 13 },
    { "reason": "Others", "percentage": 17 }
  ]
}
```

On failure `success` is `false` with an `error`; the extra fields are still
present (as whatever could be read, else `null`):

```json
{ "success": false, "error": "Seller Lens panel (#fkSellerLensSidePanel) did not load within 30000ms. ...", "price": null, "rating": null, "reviewCount": null, "returnPolicy": null, "conversionFunnel": null, "salesRank": null, "quality": null, "latchOnUrl": null, "startSellingUrl": null, "isStartSellingUrlEnable": null, "returnRate": null, "returnRateColor": null, "topReturnReasons": [] }
```

### Extra fields

| Field | Source | How it's found (stable selectors only) |
| --- | --- | --- |
| `price` | main page | current-price selectors → non-struck price leaf → "Add to cart / Buy at ₹N" CTA |
| `rating` | main page | title badge: rating leaf (`0–5`) immediately followed by the star `<svg>` |
| `reviewCount` | main page | title badge: the `\| N` count leaf right after the star `<svg>` |
| `returnPolicy` | main page | badge text: `No returns` / `7-Day Return` / `N Day(s) Replacement` / `Non-returnable`; falls back to JSON-LD `hasMerchantReturnPolicy` (`MerchantReturnNotPermitted` → `No returns`, `merchantReturnDays` → `N Days Return`). `null` (shown as `—`) when nothing is found |
| `conversionFunnel` | Seller Lens | recharts `%` value labels, in order |
| `salesRank` | Seller Lens | each `#N` leaf paired with its category sibling (any number of rows) |
| `quality` | Seller Lens | badge element directly before the `Quality` label |
| `latchOnUrl` | Seller Lens | clicks **Latch on**, captures the new tab's URL, closes it, refocuses |
| `startSellingUrl` | Seller Lens | the Latch-on URL, but only when its tab renders a *visible* **Start selling** CTA (`a.startSelling` / `.productOptions a.listingsModalLink`) inside the product card |
| `isStartSellingUrlEnable` | Seller Lens | whether the seller can actually start selling. The Latch-on tab is an SPA that always ships both the card and the `No Results found` panel, so we wait for one of them to become **visible**, then require the CTA to be visible, non-zero-sized, labelled *Start selling*, and unblocked on itself **and every ancestor up to the product card** (`disabled` / `aria-disabled` / `disabled\|inactive\|readonly\|blocked` class token / `display:none` / `visibility:hidden` / `pointer-events:none` / `cursor:not-allowed` / opacity < 0.4). `false` when the tab loaded but no usable CTA exists; `null` only when the tab never opened |
| `returnRate` | Seller Lens | **Returns & Ratings** tab → value sibling right after the `Return Rate` label (e.g. `"3.1%"`) |
| `returnRateColor` | Seller Lens | computed text color of the Return Rate value, as `#rrggbb` |
| `topReturnReasons` | Seller Lens | **Returns & Ratings** tab → every `N%` leaf paired with its reason sibling (any number of rows) |

The **Returns & Ratings** fields are scraped in a final, isolated step that runs
only after all other fields are collected: it clicks the Seller Lens **Returns &
Ratings** sidebar tab, waits for the panel to render (Playwright waits, no fixed
sleeps), then reads the values. If that tab can't be opened or has no data,
`returnRate`/`returnRateColor` come back `null` and `topReturnReasons` is `[]` —
the product (and the rest of a batch) still succeeds.

Pass `{ captureLatchOn: false }` to skip the Latch-on tab open/close on very
large batch runs.

## Product image

Every product also carries its **main product image**, scraped from the product
page and shown in the dashboard's product grid.

| Field | Source | How it is read |
| --- | --- | --- |
| `mainImage` | product page | the JSON-LD `Product.image[0]` (the default image Flipkart renders); falls back to the largest non-thumbnail `rukminim*.flixcart.com` image on the page |
| `title` | product page | the JSON-LD `Product.name`; falls back to the `<h1>` text |

`src/productImage.ts` is a **pure DOM read** — no click, no navigation, no
download, no extra tab — and it runs last, after every other field has been
collected, so it can never disturb the rest of the scrape. It never throws:
a page it cannot read yields `null` for both fields and the product still
succeeds.

In the dashboard the image renders as a thumbnail in the **Image** column of the
products table, lazily loaded and linking to the full-size CDN image. A product
with no image, or an image the CDN refuses to serve, shows a dash.

## First-run note

On a brand-new profile the extension shows an onboarding modal (FTUE) and may ask
you to **grant host permission** before it fetches product data. The script
auto-dismisses the onboarding modal, but the initial permission grant is a
one-time manual step — run `npm run setup` (which opens a real window) with a
stable `SELLER_LENS_USER_DATA_DIR`, grant permission, and every later headless
run reuses that profile.

## Programmatic use

```ts
import { scrapeFSN } from "./src/sellerLens.js";

const { success, fsn, error } = await scrapeFSN(productUrl, {
  extensionPath: "C:/path/to/seller-lens-unpacked",
});
```

Search + pagination, returning the full array:

```ts
import { scrapeSearchResults } from "./src/search.js";

const products = await scrapeSearchResults({
  keyword: "scar tape",
  startPage: 0, // exclusive → starts at page 1
  endPage: 2,   // inclusive
});
```

To drive the detail scraper yourself against a context you already own, use
`scrapeProductOnPage(context, page, url)` — the exact logic `scrapeFSN` runs,
minus the browser launch/close.

---

# Production dashboard

A scraping-management layer built **around** the scraper above. The scraper
itself (`sellerLens.ts`, `productData.ts`, `search.ts`, `index.ts`) is
unchanged — the dashboard composes its exported primitives, so `npm start`
behaves exactly as it always has.

```bash
npm run dashboard          # http://localhost:4300   (PORT=… to change)
```

## What it adds

| Capability | Where |
| --- | --- |
| Live stats, progress bar, ETA, products/min | `src/jobs/` + SSE |
| Incremental save (one append per product) | `src/storage/` |
| Crash recovery + resume | `src/checkpoint/` |
| Page-wise + master Excel export | `src/excel/` |
| Structured, downloadable logs | `src/logger/` |
| Real failure reasons + screenshots | `src/errors/` |
| Retry single / selected / all failed | `src/jobs/JobRunner.ts` |
| Dashboard UI, REST + SSE | `src/dashboard/` |
| Main product image + title | `src/productImage.ts` |

## Runtime layout

```
data/
  products.jsonl     every scraped product, appended the instant it is scraped
  failures.jsonl     every failure with stage, error type, stack, screenshot
  checkpoint.json    current page/product, completed pages, counts (atomic write)
  logs/job.jsonl     structured event log
  screenshots/       one PNG per failed product
exports/
  page-1.xlsx …      written the moment each listing page completes
  all-products.xlsx  "Export All"
```

Both directories are gitignored.

## Crash recovery

Two independent records make a resume safe:

- **`checkpoint.json`** says *where* the run was. It is written with a
  temp-file + rename, so a hard kill can never leave it half-written.
- **`products.jsonl`** says *what* is already done. Before scraping any
  product the runner checks this store, so even a checkpoint that is one
  product stale cannot cause a re-scrape.

Pages whose `page-N.xlsx` already exists are never re-exported. Kill the
process at any point, run `npm run dashboard` again, and press **Resume**.

## Scraped fields

Exactly the fields the existing scraper produces. The only rename happens at
the storage boundary: the scraper's `isStartSellingUrlEnable` is persisted and
displayed as **`isStartSellingEnable`**.

`conversionFunnel`, `salesRank` and `topReturnReasons` are structured values —
they render in the row's **Details** panel (bars and tables, never raw JSON)
and are deliberately excluded from filtering and sorting to keep the grid fast.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/stream` | SSE: stats, product, failure, log, export, status |
| GET | `/api/job/stats` | Snapshot for a freshly-loaded page |
| POST | `/api/job/start` | `{ keyword, startPage, endPage, fresh }` |
| POST | `/api/job/{pause,resume,stop}` | Control |
| GET | `/api/products` | Filter / sort / paginate |
| GET | `/api/products/filter-options` | Distinct values for multi-selects |
| GET | `/api/failures` | Failed-product list |
| POST | `/api/failures/retry` | `{ ids }` — omit for all outstanding |
| POST | `/api/exports/page/:page` | Regenerate one page workbook |
| POST | `/api/exports/all` | Merge everything |
| GET | `/api/exports/download/:file` | Download a workbook |
| GET | `/api/logs/download` | Download the structured log |

## Storage note

The store is append-only JSONL with an in-memory index, not SQLite:
`better-sqlite3` needs a native build that this environment (Node 18, no Python
toolchain) cannot produce. Appending one line per product is crash-safe and
O(1); a torn final line from a hard kill is discarded on load and that single
product is simply re-scraped on resume.



aevu kyk jone jaja page nakhi more then 2 to [ERROR] job.failed — Selector Not Found — page.waitForURL: Timeout 60000ms exceeded. =========================== logs =========================== waiting for navigation until "commit" =================…
 aaj aave chhe time gap vadhari ne jo ne kyk


 2 to 3 

kyru me

[INFO] job.started — Job started for "aluminium foil tape 4 inch"
[INFO] browser.launched — Browser launched with Seller Lens.
Opening Flipkart...

Searching: aluminium foil tape 4 inch
[ERROR] job.failed — Selector Not Found — page.waitForURL: Timeout 60000ms exceeded. =========================== logs =========================== waiting for navigation until "commit" =================…
[INFO] job.finished — Job failed — 71 ok, 0 failed.