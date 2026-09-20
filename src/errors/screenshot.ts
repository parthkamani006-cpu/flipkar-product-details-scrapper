import path from "node:path";
import type { Page } from "playwright";
import { SCREENSHOT_DIR, DATA_DIR } from "../utils/paths.js";

/** Strip characters that are illegal in a Windows filename. */
function safe(part: string): string {
  return part.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
}

/**
 * Capture a full-page screenshot of whatever state the page was left in when a
 * product failed, so the failure can be debugged after the fact.
 *
 * Strictly best-effort: if the page is already closed or crashed (which is
 * exactly when many failures happen) this returns null instead of turning a
 * product failure into a job failure.
 *
 * @returns path relative to the data dir (what we store on the failure row), or null.
 */
export async function captureFailureScreenshot(
  page: Page | undefined,
  context: { page: number; productIndex: number; pid: string },
): Promise<string | null> {
  if (!page || page.isClosed()) return null;

  const name = `p${context.page}-i${context.productIndex}-${safe(context.pid || "unknown")}-${Date.now()}.png`;
  const absolute = path.join(SCREENSHOT_DIR, name);

  try {
    await page.screenshot({ path: absolute, fullPage: true, timeout: 10_000 });
    return path.relative(DATA_DIR, absolute).split(path.sep).join("/");
  } catch {
    // Try a viewport-only shot — full-page rendering fails on some crashed pages.
    try {
      await page.screenshot({ path: absolute, timeout: 5_000 });
      return path.relative(DATA_DIR, absolute).split(path.sep).join("/");
    } catch {
      return null;
    }
  }
}
