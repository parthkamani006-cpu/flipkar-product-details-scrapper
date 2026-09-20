import type { BrowserContext, Page, Locator } from "playwright";
import { robustClick } from "./sellerLens.js";

/** Seller Lens "Conversion Funnel (Last 30 days)" percentages, sign-stripped. */
export interface ConversionFunnel {
  impressionToClick: number;
  clickToCart: number;
  cartToSale: number;
}

/** One Seller Lens "Sales Rank" row. */
export interface SalesRankEntry {
  category: string;
  rank: number;
}

/** One Seller Lens "Top Return Reasons" row (e.g. { reason: "MISSHIPMENT", percentage: 54 }). */
export interface ReturnReason {
  reason: string;
  percentage: number;
}

/** All fields added on top of the FSN result. Any field is null when unavailable. */
export interface ProductExtras {
  price: number | null;
  /** Average product rating from the title badge (e.g. 3.7). */
  rating: number | null;
  /** Total review/rating count from the title badge (e.g. 96). */
  reviewCount: number | null;
  returnPolicy: string | null;
  conversionFunnel: ConversionFunnel | null;
  salesRank: SalesRankEntry[] | null;
  quality: string | null;
  latchOnUrl: string | null;
  /** The Latch-on tab URL, but only when it exposes a "Start selling" button. */
  startSellingUrl: string | null;
  /**
   * Whether the seller can actually start selling: true only when the CTA is
   * rendered, visible and clickable. False when the Latch-on tab loaded but the
   * CTA is missing, hidden or disabled. Null only when the tab never opened.
   */
  isStartSellingUrlEnable: boolean | null;
  /** Seller Lens "Returns & Ratings" → Return Rate string (e.g. "3.1%"). */
  returnRate: string | null;
  /** Hex color of the Return Rate text (e.g. "#22c55e"), from computed style. */
  returnRateColor: string | null;
  /** Seller Lens "Top Return Reasons" rows; empty when unavailable. */
  topReturnReasons: ReturnReason[];
}

/** An all-null extras object — used as the safe default. */
export function emptyExtras(): ProductExtras {
  return {
    price: null,
    rating: null,
    reviewCount: null,
    returnPolicy: null,
    conversionFunnel: null,
    salesRank: null,
    quality: null,
    latchOnUrl: null,
    startSellingUrl: null,
    isStartSellingUrlEnable: null,
    returnRate: null,
    returnRateColor: null,
    topReturnReasons: [],
  };
}

/**
 * Wait (condition-based, no fixed sleeps) for the Seller Lens insight widgets to
 * render before we read them. Best-effort: never throws.
 */
export async function waitForInsights(panel: Locator): Promise<void> {
  await Promise.allSettled([
    panel.locator(".recharts-wrapper").first().waitFor({ state: "attached", timeout: 15_000 }),
    panel.getByText("Sales Rank", { exact: false }).first().waitFor({ state: "attached", timeout: 15_000 }),
  ]);
}

/**
 * Extract the current selling price from the main (light-DOM) product page.
 * Flipkart rotates its class names, so this tries known selectors first, then
 * falls back to a structural heuristic: the first standalone price that is
 * neither struck-through (MRP) nor inside a button (the "Buy at" CTA).
 */
export async function extractPrice(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(() => {
      const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();
      const toNumber = (t: string): number | null => {
        const m = t.match(/₹\s?([\d,]+)/);
        return m ? Number.parseInt(m[1]!.replace(/,/g, ""), 10) : null;
      };

      // 1) Known/likely current-price selectors (may or may not exist).
      for (const sel of ["div.Nx9bqj.CxhGGd", "div.Nx9bqj", "._30jeq3._16Jk6d", "._30jeq3"]) {
        const el = document.querySelector(sel);
        if (el) {
          const n = toNumber(norm(el.textContent));
          if (n != null) return n;
        }
      }

      // 2) Structural: first non-struck, non-button standalone price (the
      //    selling price in the price row; MRP is struck-through, so excluded).
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("div, span")).filter(
        (e) => e.children.length === 0 && /^₹\s?[\d,]+$/.test(norm(e.textContent)),
      );
      for (const el of nodes) {
        const style = getComputedStyle(el);
        const struck = style.textDecorationLine.includes("line-through");
        const inButton = el.closest("button, a") != null;
        if (!struck && !inButton) {
          const n = toNumber(norm(el.textContent));
          if (n != null) return n;
        }
      }

      // 3) CTA fallback: the buy-box row pairs "Add to cart" with the standard
      //    "Buy at ₹NNN" button (that price is the selling price — not the
      //    promotional WOW-deal price). Pick the smallest container holding both.
      let best: number | null = null;
      let bestLen = Infinity;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("div, section"))) {
        const t = norm(el.textContent);
        if (t.length > 120 || !/add to cart/i.test(t)) continue;
        const m = t.match(/buy at\s*₹\s?([\d,]+)/i);
        if (m && t.length < bestLen) {
          best = Number.parseInt(m[1]!.replace(/,/g, ""), 10);
          bestLen = t.length;
        }
      }
      return best;
    });
  } catch {
    return null;
  }
}

/**
 * Extract the average rating and total review/rating count from the compact
 * title badge, which renders as: <rating> <star-svg> <"| count">
 * (e.g. `3.7 ★ | 96`). Structural only — matched by the leaf→svg→count shape,
 * never by the rotating class names. Either field is null when unreadable.
 */
export async function extractRatingAndReviews(
  page: Page,
): Promise<{ rating: number | null; reviewCount: number | null }> {
  try {
    return await page.evaluate(() => {
      const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

      // The rating value is a leaf like "3.7" (0–5, one optional decimal), its
      // next sibling is the star <svg>, and the sibling after that is the count
      // ("| 96" or "96"). Requiring the star between them isolates the badge
      // from unrelated stray numbers on the page.
      const leaves = Array.from(document.querySelectorAll<HTMLElement>("div, span")).filter(
        (e) => e.children.length === 0 && /^[0-5](\.\d)?$/.test(norm(e.textContent)),
      );
      for (const el of leaves) {
        const star = el.nextElementSibling;
        if (!star || star.tagName.toLowerCase() !== "svg") continue;
        const countEl = star.nextElementSibling;
        const cm = norm(countEl?.textContent ?? "").match(/([\d,]+)/);
        if (!cm) continue;
        return {
          rating: Number.parseFloat(norm(el.textContent)),
          reviewCount: Number.parseInt(cm[1]!.replace(/,/g, ""), 10),
        };
      }
      return { rating: null, reviewCount: null };
    });
  } catch {
    return { rating: null, reviewCount: null };
  }
}

/**
 * Extract the product return policy string.
 *
 * Rules (as requested):
 *  - Product is non-returnable  → "No returns".
 *  - Product has a real policy   → the policy text shown on the page
 *                                  (e.g. "7-Day Return", "30 Day Replacement").
 *  - Nothing found on the page   → null, which the UI/exports render as "—".
 *
 * Two sources, most-reliable first:
 *  1. The visible badge in the buy-box ("No returns" / "7-Day Return" /
 *     "30 Day Replacement Guarantee"), read from short leaf nodes.
 *  2. The page's JSON-LD (`hasMerchantReturnPolicy`), which is authoritative:
 *     `MerchantReturnNotPermitted` → "No returns"; a `merchantReturnDays`
 *     window → "N Days Return".
 */
export async function extractReturnPolicy(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();
      // "No returns" / "Non-returnable" first; then a day-count window that
      // tolerates a hyphen OR space between the number and "Day(s)" and before
      // the action word, so "7-Day Return" and "30 Day Replacement" both match.
      const re =
        /(No returns?|Non[- ]?returnable|\d+[\s-]*Days?[\s-]*(?:Return Policy|Replacement Policy|Replacement|Return))/i;

      // ---- 1) Visible badge: prefer short leaf nodes so we capture the label,
      //         not a whole descriptive block. ----
      const leaves = Array.from(document.querySelectorAll<HTMLElement>("div, span, li")).filter(
        (e) => e.children.length === 0,
      );
      for (const el of leaves) {
        const t = norm(el.textContent);
        if (t.length <= 40) {
          const m = t.match(re);
          if (m) return m[0];
        }
      }
      const whole = norm(document.body.innerText).match(re);
      if (whole) return whole[0];

      // ---- 2) JSON-LD fallback (authoritative for the "No returns" case). ----
      for (const script of Array.from(
        document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
      )) {
        let data: unknown;
        try {
          data = JSON.parse(script.textContent ?? "");
        } catch {
          continue;
        }
        // The block is usually an array of nodes; the Product node carries the
        // policy on offers.hasMerchantReturnPolicy.
        for (const node of Array.isArray(data) ? data : [data]) {
          const offers = (node as { offers?: unknown })?.offers;
          const offerList = Array.isArray(offers) ? offers : [offers];
          for (const offer of offerList) {
            const policy = (offer as { hasMerchantReturnPolicy?: unknown } | null | undefined)
              ?.hasMerchantReturnPolicy as
              | { returnPolicyCategory?: string; merchantReturnDays?: number | string }
              | undefined;
            if (!policy) continue;
            const category = String(policy.returnPolicyCategory ?? "");
            if (/MerchantReturnNotPermitted/i.test(category)) return "No returns";
            const days = Number.parseInt(String(policy.merchantReturnDays ?? ""), 10);
            if (Number.isFinite(days) && days > 0) return `${days} Days Return`;
          }
        }
      }

      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Extract the Seller Lens insight widgets (conversion funnel, sales rank,
 * quality) by walking the panel's OPEN shadow root in a single pass. Structural
 * / text-based selectors only — never the generated styled-components classes.
 */
export async function extractSellerLensInsights(
  panel: Locator,
): Promise<Pick<ProductExtras, "conversionFunnel" | "salesRank" | "quality">> {
  try {
    return await panel.evaluate((host: Element) => {
      const root = (host as HTMLElement).shadowRoot;
      const out = {
        conversionFunnel: null as ConversionFunnelLike,
        salesRank: null as SalesRankLike,
        quality: null as string | null,
      };
      if (!root) return out;
      const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

      // ---- Conversion Funnel: recharts value labels ending in "%" ----
      try {
        const pcts: number[] = [];
        for (const node of Array.from(root.querySelectorAll(".recharts-wrapper text"))) {
          const m = norm(node.textContent).match(/^(\d+(?:\.\d+)?)%$/);
          if (m) pcts.push(Number.parseFloat(m[1]!));
        }
        if (pcts.length >= 3) {
          out.conversionFunnel = {
            impressionToClick: pcts[0]!,
            clickToCart: pcts[1]!,
            cartToSale: pcts[2]!,
          };
        }
      } catch {
        /* leave null */
      }

      // ---- Sales Rank: leaf div "#<n>" paired with its preceding category ----
      try {
        const ranks: { category: string; rank: number }[] = [];
        for (const el of Array.from(root.querySelectorAll<HTMLElement>("div"))) {
          if (el.children.length !== 0) continue;
          const rm = norm(el.textContent).match(/^#(\d+)$/);
          if (!rm) continue;
          const category = norm(el.previousElementSibling?.textContent ?? "");
          if (category) ranks.push({ category, rank: Number.parseInt(rm[1]!, 10) });
        }
        if (ranks.length > 0) out.salesRank = ranks;
      } catch {
        /* leave null */
      }

      // ---- Quality: badge element immediately before the "Quality" label ----
      try {
        for (const el of Array.from(root.querySelectorAll<HTMLElement>("p, span, div"))) {
          if (el.children.length !== 0) continue;
          if (norm(el.textContent) !== "Quality") continue;
          const badge = norm(el.previousElementSibling?.textContent ?? "");
          if (badge) {
            out.quality = badge;
            break;
          }
        }
      } catch {
        /* leave null */
      }

      return out;

      // Local structural type aliases (browser-context only).
      type ConversionFunnelLike =
        | { impressionToClick: number; clickToCart: number; cartToSale: number }
        | null;
      type SalesRankLike = { category: string; rank: number }[] | null;
    });
  } catch {
    return { conversionFunnel: null, salesRank: null, quality: null };
  }
}

/**
 * Detect whether the Latch-on tab exposes the "Start selling" call-to-action.
 * The button renders as `<a class="startSelling ...">START SELLING</a>`, so we
 * match it by the stable class OR by the visible link/button text — never by a
 * rotating styled-components class. Best-effort: never throws.
 */
export async function hasStartSellingButton(popup: Page, timeoutMs = 20_000): Promise<boolean> {
  return (await getStartSellingState(popup, timeoutMs)).present;
}

/** CSS for the Start-selling CTA inside the seller-hub "Add New Listings" card. */
const START_SELLING_SELECTOR =
  "a.startSelling, [analytics-action='Click start selling'], .productOptions a.listingsModalLink";

/** CSS for the "nothing to list" state the same page renders instead of a card. */
const NO_RESULT_SELECTOR = ".no-products-found-container, .empty-box-bg";

/**
 * Locate the "Start selling" call-to-action on the Latch-on tab and report both
 * whether it exists and whether the seller can actually use it.
 *
 * The Latch-on tab is an Angular SPA: `domcontentloaded` fires long before the
 * product card is rendered, and the page ships BOTH the card container and the
 * "No Results found" container in the DOM at all times — only one of them is
 * ever *visible*. So we first wait for the search to settle (card visible OR
 * empty-state visible), then judge the CTA on visibility + clickability rather
 * than on mere presence in the DOM, which was reporting "enabled" for every
 * product. `enabled` is false when the CTA — or any ancestor up to the product
 * card — is hidden, zero-sized, `disabled`, `aria-disabled`, carries a
 * disabled-ish class token, or is styled unclickable (`pointer-events: none`,
 * `cursor: not-allowed`, near-zero opacity). Best-effort: never throws.
 */
export async function getStartSellingState(
  popup: Page,
  timeoutMs = 20_000,
): Promise<{ present: boolean; enabled: boolean }> {
  const button = popup.locator(START_SELLING_SELECTOR).first();
  const emptyState = popup.locator(NO_RESULT_SELECTOR).first();

  // Wait for whichever outcome the SPA settles on — a rendered CTA or the
  // "No Results found" panel. Racing them means a genuinely empty result costs
  // us its render time, not the full timeout.
  await Promise.race([
    button.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
    emptyState.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
  ]);
  await popup.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

  try {
    if ((await button.count()) === 0) return { present: false, enabled: false };
    if (!(await button.isVisible())) return { present: false, enabled: false };
  } catch {
    return { present: false, enabled: false };
  }

  try {
    const enabled = await button.evaluate((el: Element) => {
      const isBlocked = (node: HTMLElement): boolean => {
        const anyNode = node as HTMLElement & { disabled?: boolean };
        if (anyNode.disabled === true) return true;
        if (node.hasAttribute("disabled")) return true;
        if (node.getAttribute("aria-disabled") === "true") return true;
        // `className` is a string on HTML elements but an SVGAnimatedString on SVG.
        const cls = typeof node.className === "string" ? node.className : "";
        if (/(^|[\s_-])(is)?(disabled|inactive|readonly|blocked)([\s_-]|$)/i.test(cls)) return true;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return true;
        if (style.pointerEvents === "none") return true;
        if (style.cursor === "not-allowed") return true;
        if (Number.parseFloat(style.opacity || "1") < 0.4) return true;
        return false;
      };

      const cta = el as HTMLElement;
      // A CTA the seller cannot click is often disabled via a wrapper
      // (`.productOptions`, `.primaryActionBar`, the card itself), so walk up
      // to the product card — not just the anchor.
      let node: HTMLElement | null = cta;
      while (node && node !== document.body) {
        if (isBlocked(node)) return false;
        if (node.classList.contains("productCard") || node.classList.contains("cf-list")) break;
        node = node.parentElement;
      }

      // Nothing the seller can click has zero area.
      const rect = cta.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;

      // The CTA must actually read as "start selling" — the same slot is reused
      // for other actions (e.g. "ADD VARIANT") on some verticals.
      const label = (cta.textContent || "").trim();
      if (!/start\s*selling/i.test(label)) return false;

      return true;
    });
    return { present: true, enabled };
  } catch {
    // Element vanished mid-check — treat as present but not clickable.
    return { present: true, enabled: false };
  }
}

/**
 * Click the Seller Lens "Latch on" button, capture the URL of the tab it opens,
 * and — if that tab exposes a "Start selling" button — surface the same URL as
 * `startSellingUrl` plus whether that button is enabled. Then close the tab and
 * refocus the product page. Never throws: all fields come back null if the
 * button is absent or no tab opens.
 */
export async function captureLatchOnUrl(
  context: BrowserContext,
  page: Page,
  panel: Locator,
  timeoutMs = 15_000,
): Promise<{
  latchOnUrl: string | null;
  startSellingUrl: string | null;
  isStartSellingUrlEnable: boolean | null;
}> {
  const empty = { latchOnUrl: null, startSellingUrl: null, isStartSellingUrlEnable: null };
  try {
    const button = panel.getByRole("button", { name: /latch on/i }).first();
    if ((await button.count()) === 0) return empty;
    await button.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    // Start listening BEFORE the click so we don't miss the new tab.
    const popupPromise = context.waitForEvent("page", { timeout: timeoutMs }).catch(() => null);
    await robustClick(button);

    const popup = await popupPromise;
    if (!popup) return empty;

    await popup.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    const rawUrl = popup.url();
    const url = rawUrl && rawUrl !== "about:blank" ? rawUrl : null;
    if (!url) {
      await popup.close().catch(() => {});
      await page.bringToFront().catch(() => {});
      return empty;
    }

    // Only treat the URL as a "start selling" URL when the CTA is actually
    // rendered. If the tab loaded but shows no usable CTA (empty result, or a
    // hidden/disabled one), the seller cannot start selling — that is `false`,
    // not "unknown": null is reserved for "we never got to look".
    const state = await getStartSellingState(popup);
    const startSellingUrl = state.present ? url : null;
    const isStartSellingUrlEnable = state.present ? state.enabled : false;

    await popup.close().catch(() => {});
    await page.bringToFront().catch(() => {});
    return { latchOnUrl: url, startSellingUrl, isStartSellingUrlEnable };
  } catch {
    return empty;
  }
}

/**
 * Open the Seller Lens "Returns & Ratings" sidebar tab and scrape the Return
 * Rate (with its text color) and the full "Top Return Reasons" list. This is a
 * SEPARATE step that runs only after all other extraction is done, and it never
 * throws: any failure yields { returnRate: null, returnRateColor: null,
 * topReturnReasons: [] } so the product (and the batch) still succeeds.
 */
export async function extractReturnsAndRatings(
  panel: Locator,
  timeoutMs = 15_000,
): Promise<Pick<ProductExtras, "returnRate" | "returnRateColor" | "topReturnReasons">> {
  const empty = {
    returnRate: null,
    returnRateColor: null,
    topReturnReasons: [] as ReturnReason[],
  };
  try {
    // 1) Click the "Returns & Ratings" sidebar item. Exact text avoids matching
    //    the content header "Returns & Ratings of FSN ...". Text/role selector,
    //    never the rotating styled-components class.
    const navItem = panel.getByText("Returns & Ratings", { exact: true }).first();
    if ((await navItem.count()) === 0) return empty;
    await navItem.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    await robustClick(navItem);

    // 2) Wait (condition-based, no fixed sleep) for the panel to finish
    //    rendering. If it never appears, fall through and return empty.
    await panel
      .getByText("Top Return Reasons", { exact: false })
      .first()
      .waitFor({ state: "attached", timeout: timeoutMs })
      .catch(() => {});

    // 3) Read everything from the panel's OPEN shadow root in one pass.
    const data = await panel.evaluate((host: Element) => {
      const root = (host as HTMLElement).shadowRoot;
      const out = {
        returnRate: null as string | null,
        returnRateColor: null as string | null,
        topReturnReasons: [] as { reason: string; percentage: number }[],
      };
      if (!root) return out;
      const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();
      const leaves = (): HTMLElement[] =>
        Array.from(root.querySelectorAll<HTMLElement>("span, div, p")).filter(
          (e) => e.children.length === 0,
        );
      // getComputedStyle color is "rgb(r, g, b)" / "rgba(...)"; make it "#rrggbb".
      const toHex = (rgb: string): string | null => {
        const m = rgb.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (!m) return null;
        const h = (n: string): string => Number.parseInt(n, 10).toString(16).padStart(2, "0");
        return `#${h(m[1]!)}${h(m[2]!)}${h(m[3]!)}`;
      };

      // ---- Return Rate: value is the sibling right after the "Return Rate" label ----
      try {
        for (const label of leaves()) {
          if (norm(label.textContent) !== "Return Rate") continue;
          const valEl = label.nextElementSibling as HTMLElement | null;
          const val = norm(valEl?.textContent ?? "");
          if (valEl && /^\d+(\.\d+)?%$/.test(val)) {
            out.returnRate = val;
            out.returnRateColor = toHex(getComputedStyle(valEl).color);
            break;
          }
        }
      } catch {
        /* leave null */
      }

      // ---- Top Return Reasons: every "<n>%" leaf paired with its reason sibling ----
      try {
        const labelEl = leaves().find((e) => norm(e.textContent) === "Top Return Reasons");
        const scope: ParentNode = labelEl?.parentElement ?? root;
        const reasons: { reason: string; percentage: number }[] = [];
        for (const pct of Array.from(scope.querySelectorAll<HTMLElement>("span, div, p"))) {
          if (pct.children.length !== 0) continue;
          const pm = norm(pct.textContent).match(/^(\d+)%$/);
          if (!pm) continue;
          const reason = norm((pct.nextElementSibling as HTMLElement | null)?.textContent ?? "");
          if (reason && !/%$/.test(reason)) {
            reasons.push({ reason, percentage: Number.parseInt(pm[1]!, 10) });
          }
        }
        out.topReturnReasons = reasons;
      } catch {
        /* leave [] */
      }

      return out;
    });

    return data ?? empty;
  } catch {
    return empty;
  }
}

/**
 * Extract all extra product fields. Every field fails independently to null and
 * never throws, so a single missing widget cannot abort a batch run. `captureLatchOnUrl`
 * runs last because it opens (and closes) a tab.
 */
export async function extractProductExtras(
  context: BrowserContext,
  page: Page,
  panel: Locator,
  captureLatch = true,
): Promise<ProductExtras> {
  await waitForInsights(panel);

  const [price, ratingReviews, returnPolicy, insights] = await Promise.all([
    extractPrice(page),
    extractRatingAndReviews(page),
    extractReturnPolicy(page),
    extractSellerLensInsights(panel),
  ]);

  // "Latch on" opens/closes a tab; allow skipping it to speed up big batches.
  const { latchOnUrl, startSellingUrl, isStartSellingUrlEnable } = captureLatch
    ? await captureLatchOnUrl(context, page, panel)
    : { latchOnUrl: null, startSellingUrl: null, isStartSellingUrlEnable: null };

  // NEW STEP — runs LAST, only after every field above is collected. It switches
  // the Seller Lens panel to the "Returns & Ratings" tab (which replaces the
  // Conversion Funnel view read above), so it must not run any earlier. Fully
  // isolated: on any failure it returns nulls/[] without aborting the product.
  const returns = await extractReturnsAndRatings(panel);

  return {
    price,
    rating: ratingReviews.rating,
    reviewCount: ratingReviews.reviewCount,
    returnPolicy,
    conversionFunnel: insights.conversionFunnel,
    salesRank: insights.salesRank,
    quality: insights.quality,
    latchOnUrl,
    startSellingUrl,
    isStartSellingUrlEnable,
    returnRate: returns.returnRate,
    returnRateColor: returns.returnRateColor,
    topReturnReasons: returns.topReturnReasons,
  };
}
