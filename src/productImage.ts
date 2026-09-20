import type { Page } from "playwright";

/** What the product-image step reads off the product page. */
export interface ProductImageInfo {
  /** The first/default product image shown on the page (absolute URL). */
  mainImage: string | null;
  /** Product title, shown next to the image. */
  title: string | null;
}

/**
 * Read the main product image and the product title from the ALREADY-OPEN
 * product page.
 *
 * This is a pure read: no click, no navigation, no download, no wait that could
 * change the page state the existing extractors just finished working on. It
 * runs after every existing field has been collected, so even a total failure
 * here cannot affect the scraped data — it returns nulls and never throws.
 *
 * Two sources, most reliable first:
 *   1. The page's JSON-LD Product node, whose `image[0]` IS the default image
 *      Flipkart shows and whose `name` is the canonical title. Authoritative,
 *      and immune to class-name churn.
 *   2. Structural fallback: the largest rendered image from Flipkart's CDN that
 *      is not one of the small gallery thumbnails, plus the <h1> text.
 */
export async function extractProductImageInfo(page: Page): Promise<ProductImageInfo> {
  try {
    return await page.evaluate(() => {
      const norm = (s: string | null | undefined): string | null => {
        const text = (s ?? "").replace(/\s+/g, " ").trim();
        return text.length > 0 ? text : null;
      };
      const absolute = (url: string | null): string | null => {
        if (!url) return null;
        try {
          return new URL(url, location.href).toString();
        } catch {
          return null;
        }
      };

      let image: string | null = null;
      let title: string | null = null;

      // ---- 1) JSON-LD ----
      for (const script of Array.from(
        document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
      )) {
        let data: unknown;
        try {
          data = JSON.parse(script.textContent ?? "");
        } catch {
          continue;
        }
        for (const node of Array.isArray(data) ? data : [data]) {
          const record = node as { name?: unknown; image?: unknown } | null;
          if (!record) continue;

          if (!image) {
            const raw = record.image;
            const first = Array.isArray(raw) ? raw[0] : raw;
            if (typeof first === "string") image = absolute(first);
          }
          if (!title && typeof record.name === "string") title = norm(record.name);
        }
        if (image && title) break;
      }

      // ---- 2a) fallback image: biggest non-thumbnail CDN image on the page ----
      if (!image) {
        let best: { url: string; area: number } | null = null;
        for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img"))) {
          const src = img.currentSrc || img.getAttribute("src") || "";
          // Flipkart serves every product photo from the rukminim*.flixcart.com
          // CDN under an /image/<w>/<h>/ path; anything else is chrome.
          if (!/rukminim\d*\.flixcart\.com\/image\//i.test(src)) continue;

          const rect = img.getBoundingClientRect();
          const width = rect.width || img.naturalWidth || 0;
          const height = rect.height || img.naturalHeight || 0;
          // The gallery rail renders 40x40 thumbnails; skip them so we pick the
          // large default image, not the first swatch.
          if (width < 120 || height < 120) continue;

          const area = width * height;
          if (!best || area > best.area) best = { url: src, area };
        }
        if (best) image = absolute(best.url);
      }

      // ---- 2b) fallback title: the <h1>, without its nested "read more" text ----
      if (!title) {
        const h1 = document.querySelector("h1");
        if (h1) {
          // The title element embeds an expander <div>; the leading text nodes
          // are the actual product name.
          const direct = Array.from(h1.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? "")
            .join(" ");
          title = norm(direct) ?? norm(h1.textContent);
        }
      }

      return { mainImage: image, title };
    });
  } catch {
    return { mainImage: null, title: null };
  }
}
