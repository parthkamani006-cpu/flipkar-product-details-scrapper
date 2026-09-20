import type { ErrorType, FailureStage } from "../storage/types.js";

/** Anything a failure can arrive as: an Error, a plain string, or unknown. */
export type RawError = unknown;

export interface ClassifiedError {
  errorType: ErrorType;
  stage: FailureStage;
  /** The full, human-readable reason. Never a generic placeholder. */
  message: string;
  stack: string | null;
}

/** Ordered rules — the FIRST match wins, so put specific patterns above broad ones. */
const RULES: { test: RegExp; type: ErrorType; stage: FailureStage }[] = [
  // --- Seller Lens specific (most specific first) ---
  {
    test: /seller lens panel .* did not load|#fkSellerLensSidePanel/i,
    type: "Extension Not Loaded",
    stage: "extension",
  },
  {
    test: /copy fsn.*not found|not found.*copy fsn/i,
    type: "Selector Not Found",
    stage: "fsn",
  },
  {
    test: /clipboard was empty|clipboard.*empty/i,
    type: "Clipboard Empty",
    stage: "fsn",
  },
  {
    test: /fsn not found|extension has not loaded data/i,
    type: "Seller Lens Data Missing",
    stage: "fsn",
  },

  // --- Browser/context lifecycle ---
  {
    test: /target page, context or browser has been closed|context (was )?closed|execution context was destroyed/i,
    type: "Context Closed",
    stage: "navigation",
  },
  {
    // "disconnected" must stay browser-scoped: a bare /disconnected/ also
    // matches net::ERR_INTERNET_DISCONNECTED, which is a Network Error.
    test: /browser has been closed|browser has crashed|browser closed|browser.{0,20}disconnect/i,
    type: "Browser Closed",
    stage: "navigation",
  },
  { test: /page crash|crashed|Target crashed/i, type: "Page Crash", stage: "navigation" },

  // --- Network / navigation ---
  {
    test: /net::ERR_NAME_NOT_RESOLVED|net::ERR_INTERNET_DISCONNECTED|net::ERR_CONNECTION|net::ERR_NETWORK|ECONNRESET|ENOTFOUND|socket hang up/i,
    type: "Network Error",
    stage: "navigation",
  },
  {
    test: /net::ERR_ABORTED|404|page not found|product (is )?(no longer available|removed|unavailable)/i,
    type: "Product Removed",
    stage: "navigation",
  },
  {
    test: /page\.goto|navigating to|navigation timeout|waiting until "(domcontentloaded|load|commit)"/i,
    type: "Navigation Timeout",
    stage: "navigation",
  },

  // --- Interaction obstacles ---
  { test: /captcha|are you a robot|unusual traffic/i, type: "Captcha", stage: "panel" },
  {
    test: /intercepts pointer events|element is not visible|element is outside of the viewport|subtree intercepts/i,
    type: "Unexpected Popup",
    stage: "panel",
  },

  // --- Generic selector/timeout ---
  {
    test: /waiting for (locator|selector)|locator\.\w+: Timeout|Timeout \d+ms exceeded|strict mode violation|no element(s)? found/i,
    type: "Selector Not Found",
    stage: "extraction",
  },

  // --- In-page JS ---
  {
    test: /TypeError|ReferenceError|SyntaxError|is not a function|cannot read propert/i,
    type: "JavaScript Exception",
    stage: "extraction",
  },
];

/** Pull a readable message out of whatever was thrown. */
function messageOf(err: RawError): string {
  if (err instanceof Error) return err.message || err.name || String(err);
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === "string" && maybe.trim() !== "") return maybe;
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/**
 * Turn any failure into a specific, actionable reason.
 *
 * The classifier reads BOTH the raw text and the stage the runner was in when
 * the failure happened, because the same Playwright timeout means different
 * things during navigation versus during field extraction.
 *
 * When nothing matches we return "Unknown Error" — but always WITH the raw
 * message and stack attached, so the UI still shows a real reason rather than
 * "something went wrong".
 */
export function classifyError(err: RawError, stage: FailureStage = "unknown"): ClassifiedError {
  const message = messageOf(err).trim() || "Failure reported with no message.";
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : null;

  for (const rule of RULES) {
    if (rule.test.test(message)) {
      return {
        errorType: rule.type,
        // Trust the caller's stage when it knows one; fall back to the rule's.
        stage: stage === "unknown" ? rule.stage : stage,
        message,
        stack,
      };
    }
  }

  return { errorType: "Unknown Error", stage, message, stack };
}

/** One-line summary for the dashboard: "Navigation Timeout — page.goto: Timeout 60000ms…". */
export function describeError(classified: ClassifiedError, maxLength = 160): string {
  const flat = classified.message.replace(/\s+/g, " ").trim();
  const short = flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
  return `${classified.errorType} — ${short}`;
}
