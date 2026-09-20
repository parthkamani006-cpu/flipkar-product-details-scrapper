import type { Page } from "playwright";

/**
 * Human-like idle behaviour, performed BETWEEN products.
 *
 * This module is deliberately isolated from the scraping logic: it never reads
 * data, never clicks, and never navigates. It only moves the mouse, hovers and
 * scrolls a little on the page that is already open, so the traffic pattern
 * between two product visits does not look like a metronome.
 *
 * Every call is non-throwing — an idle flourish must never be able to fail a
 * scrape. Disable it entirely with HUMAN_BEHAVIOR=0 (see `isHumanBehaviorEnabled`).
 */

/** Total budget for one `humanBehavior()` call, in milliseconds. */
const MIN_TOTAL_MS = 500;
const MAX_TOTAL_MS = 3_000;

/** Elements that are safe to hover: purely presentational, no state change. */
const HOVER_TARGETS = [
  "div[data-id] img",
  "div[data-id]",
  "img",
  "h1, h2",
  "footer",
];

/** Inclusive-ish random integer in [min, max). */
function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

/** Random float in [min, max). */
function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Pick a random element of a non-empty array. */
function pick<T>(items: readonly T[]): T {
  return items[randInt(0, items.length)]!;
}

/** Fisher–Yates shuffle on a copy — used to vary the order of actions. */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(0, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ease-in-out curve. Applied to the progress of a mouse path so the pointer
 * accelerates away from the start and decelerates into the target instead of
 * travelling at a constant, machine-like speed.
 */
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** The current viewport, with a sane fallback when it is not set. */
function viewportOf(page: Page): { width: number; height: number } {
  const vp = page.viewportSize();
  return { width: vp?.width ?? 1280, height: vp?.height ?? 800 };
}

/**
 * Move the mouse from its last known position to (x, y) along a curved path.
 *
 * The path is a quadratic Bézier whose control point is offset perpendicular-ish
 * to the straight line, so the pointer arcs rather than sliding along a ruler.
 * Steps are eased and separated by small jittered pauses to vary the speed.
 */
async function humanMouseMove(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.min(40, Math.max(8, Math.round(distance / randFloat(12, 28))));

  // Control point: the midpoint pushed sideways by a random amount that scales
  // with the distance travelled (short hops stay almost straight).
  const bow = randFloat(0.08, 0.25) * distance * (Math.random() < 0.5 ? -1 : 1);
  const cx = (from.x + to.x) / 2 + bow * randFloat(-1, 1);
  const cy = (from.y + to.y) / 2 + bow * randFloat(-1, 1);

  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps);
    const inv = 1 - t;
    const x = inv * inv * from.x + 2 * inv * t * cx + t * t * to.x;
    const y = inv * inv * from.y + 2 * inv * t * cy + t * t * to.y;
    await page.mouse.move(x, y);
    // Occasional micro-hesitation, like a hand that is not perfectly steady.
    if (Math.random() < 0.15) await sleep(randInt(8, 40));
  }

  return to;
}

/** Move to a random point inside a safe inner band of the viewport. */
async function wanderInViewport(
  page: Page,
  cursor: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const { width, height } = viewportOf(page);
  // Keep away from the extreme edges, where the sticky header / floating
  // widgets live, to avoid hovering anything interactive by accident.
  const target = {
    x: randFloat(width * 0.15, width * 0.85),
    y: randFloat(height * 0.2, height * 0.8),
  };
  return humanMouseMove(page, cursor, target);
}

/**
 * Drift the pointer past the viewport edge and back — people do leave the page
 * (to the tab bar, another window) and return.
 */
async function leaveAndReturn(
  page: Page,
  cursor: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const { width, height } = viewportOf(page);
  const outside = pick([
    { x: randFloat(0, width), y: -randFloat(20, 120) },
    { x: randFloat(0, width), y: height + randFloat(20, 120) },
    { x: -randFloat(20, 120), y: randFloat(0, height) },
    { x: width + randFloat(20, 120), y: randFloat(0, height) },
  ]);

  let at = await humanMouseMove(page, cursor, outside);
  await sleep(randInt(80, 400));
  return wanderInViewport(page, at);
}

/**
 * Hover a random non-interactive element. Strictly hover — never click — and
 * only over presentational nodes (images, headings, card bodies, footer).
 */
async function hoverSomething(
  page: Page,
  cursor: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  for (const selector of shuffle(HOVER_TARGETS)) {
    const nodes = page.locator(selector);
    const count = await nodes.count().catch(() => 0);
    if (count === 0) continue;

    const box = await nodes
      .nth(randInt(0, Math.min(count, 12)))
      .boundingBox()
      .catch(() => null);
    if (!box || box.width < 4 || box.height < 4) continue;

    const { width, height } = viewportOf(page);
    const target = {
      x: box.x + randFloat(0.25, 0.75) * box.width,
      y: box.y + randFloat(0.25, 0.75) * box.height,
    };
    // Off-screen after scrolling? Skip rather than force the page to move.
    if (target.x < 0 || target.y < 0 || target.x > width || target.y > height) continue;

    const at = await humanMouseMove(page, cursor, target);
    await sleep(randInt(120, 600)); // linger, as a reader would
    return at;
  }
  // Nothing hoverable found — fall back to a plain wander so the call still
  // produces some movement.
  return wanderInViewport(page, cursor);
}

/**
 * Scroll in small increments, mostly downward, occasionally back up. Never a
 * jump to the bottom of the document.
 */
async function humanScroll(page: Page): Promise<void> {
  const bursts = randInt(1, 4);
  for (let i = 0; i < bursts; i++) {
    const up = Math.random() < 0.35;
    const delta = randInt(60, 260) * (up ? -1 : 1);
    await page.mouse.wheel(0, delta);
    await sleep(randInt(90, 420)); // pause after each burst, like reading
  }
  // A slightly longer settle once the scrolling stops.
  if (Math.random() < 0.6) await sleep(randInt(150, 600));
}

/** One idle action the helper may choose to perform. */
type Action = (
  page: Page,
  cursor: { x: number; y: number },
) => Promise<{ x: number; y: number } | void>;

const ACTIONS: readonly { run: Action; weight: number }[] = [
  { run: (page, cursor) => wanderInViewport(page, cursor), weight: 5 },
  { run: (page, cursor) => hoverSomething(page, cursor), weight: 4 },
  { run: (page) => humanScroll(page), weight: 4 },
  { run: (page, cursor) => leaveAndReturn(page, cursor), weight: 1 },
  // Pure idle: sometimes a person just… stops for a moment.
  { run: async () => void (await sleep(randInt(200, 900))), weight: 2 },
];

/** Weighted random choice over ACTIONS. */
function pickAction(): Action {
  const total = ACTIONS.reduce((sum, a) => sum + a.weight, 0);
  let roll = Math.random() * total;
  for (const action of ACTIONS) {
    roll -= action.weight;
    if (roll <= 0) return action.run;
  }
  return ACTIONS[0]!.run;
}

/** `HUMAN_BEHAVIOR=0|false|no|off` turns the whole helper off. */
export function isHumanBehaviorEnabled(): boolean {
  const flag = (process.env.HUMAN_BEHAVIOR ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "no" || flag === "off");
}

/**
 * Perform a short, randomised burst of human-like idle behaviour on `page`.
 *
 * Picks 1–3 weighted-random actions (move / hover / scroll / leave-and-return /
 * just wait) in a random order and runs them within a random 500–3000 ms budget,
 * so no two calls look the same. Purely additive: it does not click, navigate,
 * or read any data, and it swallows every error.
 */
export async function humanBehavior(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed() || !isHumanBehaviorEnabled()) return;

  const budgetMs = randInt(MIN_TOTAL_MS, MAX_TOTAL_MS);
  const deadline = Date.now() + budgetMs;
  const { width, height } = viewportOf(page);

  // Playwright has no cursor-position getter, so we track it ourselves and
  // start from a random plausible spot.
  let cursor = { x: randFloat(width * 0.2, width * 0.8), y: randFloat(height * 0.2, height * 0.8) };

  try {
    const actionCount = randInt(1, 4); // 1–3 actions
    for (let i = 0; i < actionCount; i++) {
      if (Date.now() >= deadline) break;
      const next = await pickAction()(page, cursor);
      if (next) cursor = next;
      // Short, always-different gap between actions.
      await sleep(randInt(60, 260));
    }

    // Spend whatever is left of the budget idling, so the total gap between two
    // products lands inside the 500–3000 ms window rather than being fixed.
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(remaining);
  } catch {
    // Idle behaviour is cosmetic — a detached element, a navigation mid-move or
    // a closed page must never affect the scrape.
  }
}
