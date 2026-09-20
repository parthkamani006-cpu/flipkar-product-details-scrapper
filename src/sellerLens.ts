import {
  chromium,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractProductExtras,
  emptyExtras,
  type ProductExtras,
} from "./productData.js";
import { extractProductImageInfo, type ProductImageInfo } from "./productImage.js";

/**
 * Stable selector for the Seller Lens side panel host element.
 * The panel exposes an OPEN shadow root, so Playwright pierces it automatically
 * for CSS / getByRole / getByText selectors.
 */
const SELLER_LENS_HOST = "#fkSellerLensSidePanel";

/** Chrome Web Store id of the Seller Lens extension (used for auto-discovery). */
const SELLER_LENS_EXTENSION_ID = "ojboogfmlehbcggdlbgacckibolpmcdh";

/**
 * Best-effort auto-discovery of the installed, unpacked Seller Lens extension.
 * Scans the local Chrome/Edge "User Data" trees across every profile for
 *   Extensions/<id>/<version>/manifest.json
 * and returns the highest-versioned folder found. Returns undefined if none.
 */
export function discoverExtensionPath(): string | undefined {
  const localAppData =
    process.env.LOCALAPPDATA ??
    (process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local")
      : undefined);
  const home = os.homedir();

  const userDataRoots = [
    localAppData && path.join(localAppData, "Google", "Chrome", "User Data"),
    localAppData && path.join(localAppData, "Google", "Chrome Beta", "User Data"),
    localAppData && path.join(localAppData, "Microsoft", "Edge", "User Data"),
    // macOS / Linux fallbacks.
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, ".config", "google-chrome"),
  ].filter((p): p is string => typeof p === "string" && fs.existsSync(p));

  const candidates: { version: string; dir: string }[] = [];
  for (const root of userDataRoots) {
    let profiles: string[];
    try {
      profiles = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const profile of profiles) {
      const extRoot = path.join(root, profile, "Extensions", SELLER_LENS_EXTENSION_ID);
      let versions: string[];
      try {
        versions = fs.readdirSync(extRoot);
      } catch {
        continue;
      }
      for (const version of versions) {
        const dir = path.join(extRoot, version);
        if (fs.existsSync(path.join(dir, "manifest.json"))) {
          candidates.push({ version, dir });
        }
      }
    }
  }

  if (candidates.length === 0) return undefined;

  // Highest version wins (numeric-aware compare on the "0.0.68_0" style tag).
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0]!.dir;
}

/** Compare "0.0.68_0"-style version tags numerically. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split(/[._]/).map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Visible label of the button we need to click. */
const COPY_FSN_LABEL = /copy fsn/i;

export interface FSNResult extends ProductExtras, Partial<ProductImageInfo> {
  /** True when an FSN was successfully read from the clipboard. */
  success: boolean;
  /** The copied FSN string (present when success is true). */
  fsn?: string;
  /** Human-readable failure reason (present when success is false). */
  error?: string;
  // NOTE: `mainImage` / `title` come from ProductImageInfo. They are absent only
  // when the product page could not be read at all.
}

export interface ScrapeOptions {
  /**
   * Absolute path to the UNPACKED Seller Lens extension directory
   * (the folder containing manifest.json).
   * Defaults to the SELLER_LENS_PATH environment variable.
   */
  extensionPath?: string;
  /**
   * Persistent Chrome user-data dir. Keeping it stable across runs preserves
   * the extension's onboarding + host-permission state so the first-run
   * tutorial (FTUE) does not reappear every time.
   * Defaults to SELLER_LENS_USER_DATA_DIR, else a stable folder in the OS temp dir.
   */
  userDataDir?: string;
  /**
   * Run without a visible window. Defaults to TRUE — scraping is a background
   * job. Chromium's new headless mode (via the full `chromium` channel) still
   * loads the MV3 extension, so headless is no longer a reliability trade-off.
   * Only `npm run setup` forces this to false, since that step needs you to log in.
   */
  headless?: boolean;
  /** Max time (ms) to wait for the Seller Lens panel to appear. */
  panelTimeoutMs?: number;
  /**
   * Click "Latch on" to capture latchOnUrl. Defaults to true. Set false to skip
   * the extra tab open/close on very large batch runs.
   */
  captureLatchOn?: boolean;
}

/** Small typed sleep that also works inside page contexts. */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the persistent Chrome profile directory. Priority:
 *   explicit option -> SELLER_LENS_USER_DATA_DIR env -> stable folder in home.
 * Using a STABLE (non-temp) path is what preserves the Flipkart login and the
 * extension's permission grant across runs, so you only sign in once.
 */
export function resolveProfileDir(explicit?: string): string {
  return (
    explicit ??
    process.env.SELLER_LENS_USER_DATA_DIR ??
    path.join(os.homedir(), ".seller-lens-profile")
  );
}

/**
 * Path to the saved auth snapshot (cookies + storage). Priority:
 *   explicit -> SELLER_LENS_AUTH_FILE env -> stable file in home.
 */
export function resolveAuthFile(explicit?: string): string {
  return (
    explicit ??
    process.env.SELLER_LENS_AUTH_FILE ??
    path.join(os.homedir(), ".seller-lens-auth.json")
  );
}

/**
 * Persist the current session (cookies incl. session-only ones + localStorage)
 * to disk. Call this after an interactive login so it survives browser restarts.
 */
export async function saveAuthState(
  context: BrowserContext,
  authFile = resolveAuthFile(),
): Promise<void> {
  await context.storageState({ path: authFile });
}

/**
 * Re-inject previously-saved cookies into a fresh context. This is what makes
 * the seller.flipkart.com login survive across runs — Chromium otherwise drops
 * session cookies when the browser process exits.
 * @returns true if a saved session was found and applied.
 */
export async function restoreAuthState(
  context: BrowserContext,
  authFile = resolveAuthFile(),
): Promise<boolean> {
  if (!fs.existsSync(authFile)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(authFile, "utf8")) as {
      cookies?: Parameters<BrowserContext["addCookies"]>[0];
    };
    if (raw.cookies && raw.cookies.length > 0) {
      await context.addCookies(raw.cookies);
      return true;
    }
  } catch {
    // Corrupt/partial file — treat as "no saved session".
  }
  return false;
}

/**
 * Launch Chromium with the Seller Lens extension loaded via a persistent context.
 * Extensions can only be loaded through launchPersistentContext (Chromium only).
 */
export async function launchWithSellerLens(
  opts: ScrapeOptions = {},
): Promise<BrowserContext> {
  const extensionPath =
    opts.extensionPath ?? process.env.SELLER_LENS_PATH ?? discoverExtensionPath();
  if (!extensionPath) {
    throw new Error(
      "Could not locate the Seller Lens extension automatically. Set SELLER_LENS_PATH " +
        "(or pass extensionPath) to the unpacked extension folder that contains manifest.json.",
    );
  }
  if (!fs.existsSync(path.join(extensionPath, "manifest.json"))) {
    throw new Error(
      `No manifest.json found in extension path: ${extensionPath}. ` +
        "Point this at the UNPACKED extension directory.",
    );
  }

  const userDataDir = resolveProfileDir(opts.userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });

  // Headless is the DEFAULT: the whole scrape runs with no visible window.
  const headless = opts.headless ?? true;

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    // MV3 extensions do NOT load in the old "headless shell" build. The full
    // Chromium channel runs Chrome's *new* headless mode, which is a real
    // browser with no window — extensions, service workers and the clipboard
    // all behave exactly as they do headed.
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Keep a stable viewport-sized window offscreen in every mode, so no
      // window can flash onto the desktop while the run starts up.
      "--window-size=1440,900",
      ...(headless ? ["--window-position=-32000,-32000"] : []),
    ],
  });

  // tsx/esbuild ("keep-names") injects __name() helper calls into evaluate()
  // bodies; define it in every page so those helpers resolve in-browser.
  await context.addInitScript(() => {
    const g = globalThis as unknown as { __name?: (f: unknown) => unknown };
    if (!g.__name) g.__name = (f) => f;
  });

  // Reading the clipboard requires explicit permission for the target origin.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "https://www.flipkart.com",
  });

  // Re-inject the saved seller session so login survives across runs.
  await restoreAuthState(context);

  return context;
}

/**
 * Wait until the Seller Lens side panel is attached to the page.
 * @throws if the panel never appears within the timeout.
 */
export async function waitForSellerLens(
  page: Page,
  timeoutMs = 30_000,
): Promise<Locator> {
  const panel = page.locator(SELLER_LENS_HOST);
  try {
    await panel.waitFor({ state: "attached", timeout: timeoutMs });
  } catch {
    throw new Error(
      `Seller Lens panel (${SELLER_LENS_HOST}) did not load within ${timeoutMs}ms. ` +
        "Confirm the extension is installed, enabled, and has permission for this page.",
    );
  }
  return panel;
}

/**
 * Best-effort dismissal of the first-time-user-experience (FTUE) onboarding
 * modal, which can overlay and intercept clicks on the panel. Non-fatal:
 * if nothing is showing, this simply returns.
 */
export async function dismissOnboarding(page: Page): Promise<void> {
  const dismissers = [
    page.locator(".ftue-close-button"),
    page.locator(".ftue-skip-button"),
    page.getByRole("button", { name: /^(skip|close|got it|done|maybe later)$/i }),
    page.locator(".update-close-button"),
  ];
  for (const candidate of dismissers) {
    try {
      const first = candidate.first();
      if (await first.isVisible({ timeout: 500 })) {
        await first.click({ timeout: 2_000 });
        await wait(300);
      }
    } catch {
      // Modal not present / already gone — ignore.
    }
  }
}

/**
 * Locate and click the "Copy FSN" button inside the Seller Lens panel.
 * Uses only stable selectors (role + visible text), never generated
 * styled-components class names. Falls back to force + programmatic click
 * so a low z-index or overlay cannot silently block the action.
 * @throws with a descriptive message if the button is missing.
 */
export async function clickCopyFSN(
  page: Page,
  panel: Locator,
  timeoutMs = 15_000,
): Promise<void> {
  // Prefer an accessible-role match; fall back to a text-scoped button match.
  const byRole = panel.getByRole("button", { name: COPY_FSN_LABEL });
  const byText = panel.locator("button", { hasText: COPY_FSN_LABEL });

  let button: Locator = byRole;
  try {
    await button.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    button = byText;
    try {
      await button.first().waitFor({ state: "visible", timeout: 3_000 });
    } catch {
      throw new Error(
        '"Copy FSN" button was not found inside the Seller Lens panel.',
      );
    }
  }

  await robustClick(button.first());
}

/**
 * Click a locator resiliently, tolerating overlays / low z-index:
 *   1) normal click, 2) force click (skip overlap checks),
 *   3) native DOM click on the element (still fires React handlers).
 * @throws if the element detaches before any strategy succeeds.
 */
export async function robustClick(target: Locator): Promise<void> {
  try {
    await target.click({ timeout: 5_000 });
    return;
  } catch {
    /* fall through */
  }
  try {
    await target.click({ force: true, timeout: 5_000 });
    return;
  } catch {
    /* fall through */
  }
  const handle = await target.elementHandle();
  if (!handle) {
    throw new Error("Target element became detached before it could be clicked.");
  }
  await handle.evaluate((el) => (el as HTMLElement).click());
}

/**
 * Read the clipboard, polling until a non-empty value appears (the copy
 * handler may write asynchronously). The page must be focused, so callers
 * should bringToFront() first.
 */
export async function getClipboardText(
  page: Page,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let value = "";
  do {
    value = await page
      .evaluate(() => navigator.clipboard.readText())
      .catch(() => "");
    value = value.trim();
    if (value) return value;
    await wait(200);
  } while (Date.now() < deadline);
  return value;
}

/**
 * Scrape ONE product using an ALREADY-OPEN context + page. This is the exact
 * product-detail logic that `scrapeFSN` has always run; it was split out so a
 * batch/search run can reuse a single browser session instead of relaunching
 * Chromium per product. Behaviour is unchanged — it still never throws.
 */
export async function scrapeProductOnPage(
  context: BrowserContext,
  page: Page,
  productUrl: string,
  opts: ScrapeOptions = {},
): Promise<FSNResult> {
  try {
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.bringToFront();

    const panel = await waitForSellerLens(page, opts.panelTimeoutMs ?? 30_000);
    await dismissOnboarding(page);

    // --- FSN copy (existing behaviour), isolated so it can't abort extras ---
    let fsn = "";
    let fsnError: string | null = null;
    try {
      // Clear any stale clipboard value so we can detect the fresh copy.
      await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
      await clickCopyFSN(page, panel);
      fsn = await getClipboardText(page);
      if (!fsn) {
        fsnError =
          "Clicked 'Copy FSN' but the clipboard was empty. The page may not have been focused, " +
          "or the extension has not loaded data for this product yet.";
      }
    } catch (err) {
      fsnError = err instanceof Error ? err.message : String(err);
    }

    // --- New fields. Each fails independently to null; never throws. ---
    const extras = await extractProductExtras(
      context,
      page,
      panel,
      opts.captureLatchOn !== false,
    );

    // --- Main product image + title. Runs LAST, immediately after the product
    // has been scraped, on the SAME page and context — a pure DOM read, no
    // extra browser, no extra tab, no download. Never throws. ---
    const image = await extractProductImageInfo(page);

    if (fsn) {
      return { success: true, fsn, ...extras, ...image };
    }
    return { success: false, error: fsnError ?? "FSN not found", ...extras, ...image };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ...emptyExtras(),
    };
  }
}

/**
 * End-to-end flow: open the product URL, wait for Seller Lens, click "Copy FSN",
 * and return the copied FSN from the clipboard. Never throws — failures are
 * returned as { success: false, error }.
 */
export async function scrapeFSN(
  productUrl: string,
  opts: ScrapeOptions = {},
): Promise<FSNResult> {
  let context: BrowserContext | undefined;
  try {
    context = await launchWithSellerLens(opts);
    const page = context.pages()[0] ?? (await context.newPage());
    return await scrapeProductOnPage(context, page, productUrl, opts);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ...emptyExtras(),
    };
  } finally {
    await context?.close();
  }
}
