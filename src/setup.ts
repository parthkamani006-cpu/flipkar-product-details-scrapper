import {
  launchWithSellerLens,
  resolveProfileDir,
  resolveAuthFile,
  saveAuthState,
} from "./sellerLens.js";

/**
 * One-time interactive setup.
 *
 * Opens a real browser window using the SAME persistent profile the scraper
 * uses. Log into Flipkart and grant the Seller Lens extension its permission
 * here, ONCE. Everything is written to disk, so every later `npm start` reuses
 * this session — no repeated logins.
 */
function waitForEnter(promptText: string): Promise<void> {
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

/** Flipkart Seller Hub — this is the login Seller Lens actually relies on. */
const SELLER_PORTAL_URL = "https://seller.flipkart.com/";

async function main(): Promise<void> {
  const profileDir = resolveProfileDir();
  console.log(`\nUsing persistent profile:\n  ${profileDir}\n`);

  const context = await launchWithSellerLens({ headless: false });
  const page = context.pages()[0] ?? (await context.newPage());

  // Log into the SELLER portal (seller.flipkart.com), not consumer flipkart.com.
  await page.goto(SELLER_PORTAL_URL, { waitUntil: "domcontentloaded" });

  console.log(
    [
      "──────────────────────────────────────────────────────────────",
      " In the browser window that just opened:",
      "   1. Log into the FLIPKART SELLER portal (seller.flipkart.com)",
      "      — this is the account Seller Lens reads data from.",
      "   2. Then open any Flipkart PRODUCT page in the same window and",
      "      let the Seller Lens side panel load.",
      "   3. If the extension shows a 'Grant permission' banner, click it.",
      "",
      " When the panel shows data, come back here.",
      "──────────────────────────────────────────────────────────────",
    ].join("\n"),
  );

  await waitForEnter("\n>>> Press ENTER here to save the session and close... ");

  // Snapshot cookies (incl. session-only) so they survive future browser restarts.
  const authFile = resolveAuthFile();
  await saveAuthState(context, authFile);
  await context.close();

  console.log(`\n✅ Session saved to:\n  ${authFile}`);
  console.log("You can now run `npm start` without logging in again.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
