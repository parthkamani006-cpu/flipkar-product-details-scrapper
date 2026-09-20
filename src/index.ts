import fs from "node:fs";
import path from "node:path";
import { scrapeFSN, type FSNResult } from "./sellerLens.js";
import { scrapeSearchResults } from "./search.js";

/** Where the search run writes its combined output. */
const RESULT_FILE = path.resolve(process.cwd(), "result.json");

/** Print usage help to stderr. */
function printUsage(): void {
  console.error(
    [
      "Scrape Flipkart products for the FSN + product fields.",
      "",
      "Search mode (search a keyword, then scrape every product on a page range):",
      "  npm start -- --search 'scar tape' --start-page 0 --end-page 2",
      "",
      "  --search <keyword>      Keyword typed into the Flipkart search box.",
      "  --start-page <n>        Exclusive lower bound. 0 => start at page 1.",
      "  --end-page <n>          Inclusive upper bound.",
      "                          start=0,end=2 -> pages 1,2 | start=5,end=8 -> pages 6,7,8",
      "",
      `  Writes every scraped product as one JSON array to ${RESULT_FILE}.`,
      "  Each product carries its main product image URL as `mainImage`.",
      "",
      "URL mode (unchanged):",
      "  npm start -- '<flipkart-product-url>' ['<url2>' ...]",
      "",
      "  Example:",
      "    npm start -- 'https://www.flipkart.com/.../p/itm...?pid=STIHNUAYF3J8ZGHZ'",
      "",
      "  IMPORTANT: wrap each URL in SINGLE QUOTES. A Flipkart URL contains '&',",
      "  which your shell treats as 'run in background' and splits the URL if unquoted.",
      "",
      "Runs headless (no visible browser) by default.",
      "Env: HEADLESS=0 to watch the browser while debugging; see README for SELLER_LENS_* vars.",
    ].join("\n"),
  );
}

/** A CLI arg is a URL we accept only if it parses as an http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

interface ParsedArgs {
  search?: string;
  startPage?: number;
  endPage?: number;
  urls: string[];
}

/** Parse `--flag value` / `--flag=value` options; anything else is a URL. */
function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { urls: [] };
  const aliases: Record<string, "search" | "startPage" | "endPage"> = {
    "--search": "search",
    "--keyword": "search",
    "-s": "search",
    "--start-page": "startPage",
    "--startpage": "startPage",
    "--start": "startPage",
    "--end-page": "endPage",
    "--endpage": "endPage",
    "--end": "endPage",
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!.trim();
    if (raw.length === 0) continue;

    if (raw.startsWith("-")) {
      const eq = raw.indexOf("=");
      const flag = (eq === -1 ? raw : raw.slice(0, eq)).toLowerCase();
      const key = aliases[flag];
      if (!key) throw new Error(`Unknown option: ${flag}`);

      const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
      if (value == null) throw new Error(`Option ${flag} needs a value.`);

      if (key === "search") {
        out.search = value.trim();
      } else {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`Option ${flag} needs a non-negative integer, got "${value}".`);
        }
        out[key] = n;
      }
      continue;
    }

    out.urls.push(raw);
  }
  return out;
}

/** Resolve HEADLESS env (headless is the default). */
function resolveHeadless(): boolean {
  const flag = (process.env.HEADLESS ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "no");
}

/** Search a keyword and scrape every product across the requested page range. */
async function runSearchMode(args: ParsedArgs): Promise<never> {
  const keyword = args.search!;
  if (keyword.length === 0) {
    console.error("Error: --search needs a non-empty keyword.\n");
    printUsage();
    process.exit(2);
  }
  if (args.endPage == null) {
    console.error("Error: --end-page is required in search mode.\n");
    printUsage();
    process.exit(2);
  }

  const startPage = args.startPage ?? 0;
  const endPage = args.endPage;

  const results = await scrapeSearchResults({
    keyword,
    startPage,
    endPage,
    headless: resolveHeadless(),
  });

  console.error("\nWriting result.json");
  fs.writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2), "utf8");

  const ok = results.filter((r) => r.success).length;
  console.error(
    `Completed — ${results.length} products (${ok} succeeded, ${results.length - ok} failed) -> ${RESULT_FILE}`,
  );

  // Failing products are logged and skipped by design, so the run itself only
  // fails when it produced nothing at all.
  process.exit(results.length === 0 ? 1 : 0);
}

/** Original behaviour: scrape the product URLs passed on the command line. */
async function runUrlMode(urls: string[]): Promise<never> {
  const invalid = urls.filter((u) => !isHttpUrl(u));
  if (invalid.length > 0) {
    console.error(`Error: not valid http(s) URL(s): ${invalid.join(", ")}\n`);
    printUsage();
    process.exit(2);
  }

  const headless = resolveHeadless();

  // Scrape each URL (sequential — each run drives its own browser context).
  const results: FSNResult[] = [];
  for (const url of urls) {
    // extensionPath / userDataDir fall back to env vars (see README).
    results.push(await scrapeFSN(url, { headless }));
  }

  // One URL → a single object; many → an array. Machine-readable either way.
  console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));

  // Exit non-zero if ANY scrape failed, so batch runs surface problems.
  process.exit(results.every((r) => r.success) ? 0 : 1);
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    printUsage();
    process.exit(2);
  }

  if (args.search != null) return runSearchMode(args);
  if (args.urls.length > 0) return runUrlMode(args.urls);

  console.error("Error: provide either --search <keyword> or a product URL.\n");
  printUsage();
  process.exit(2);
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: String(err) }, null, 2));
  process.exit(1);
});
