/** Lifecycle of a scraping job. */
export type JobStatus =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

/** Everything the dashboard header needs, computed in one place. */
export interface JobStats {
  status: JobStatus;
  keyword: string;
  startPage: number;
  endPage: number;

  totalProducts: number;
  /** True when totalProducts is still an estimate (pages not yet visited). */
  totalIsEstimate: boolean;
  completedProducts: number;
  remainingProducts: number;
  successCount: number;
  failedCount: number;

  currentPage: number | null;
  currentProduct: number | null;
  currentProductLabel: string | null;
  completedPages: number[];

  progressPercent: number;
  runningTimeMs: number;
  estimatedRemainingMs: number | null;
  productsPerMinute: number;
  lastUpdated: string;
}

/** Thrown internally to unwind the scrape loop when Stop is pressed. */
export class StopSignal extends Error {
  constructor() {
    super("Job stopped by user");
    this.name = "StopSignal";
  }
}

/**
 * Pause/stop control.
 *
 * The runner awaits `gate()` at product boundaries only — never mid-product —
 * so a pause always leaves the browser and the checkpoint in a consistent
 * state, and a resumed run never has to re-do a half-finished product.
 */
export class ControlGate {
  private paused = false;
  private stopped = false;
  private waiters: (() => void)[] = [];

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) resolve();
  }

  stop(): void {
    this.stopped = true;
    // Release anyone parked on a pause so they can observe the stop.
    this.resume();
  }

  reset(): void {
    this.paused = false;
    this.stopped = false;
    this.waiters = [];
  }

  isPaused(): boolean {
    return this.paused;
  }
  isStopped(): boolean {
    return this.stopped;
  }

  /** Block while paused; throw StopSignal if a stop was requested. */
  async gate(): Promise<void> {
    if (this.stopped) throw new StopSignal();
    while (this.paused && !this.stopped) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.stopped) throw new StopSignal();
  }
}

/**
 * Throughput tracker.
 *
 * Rate is computed over a sliding window of recent completions rather than the
 * lifetime average, because one slow page early in a long run would otherwise
 * skew the ETA for the rest of the job.
 */
export class RateTracker {
  private readonly completions: number[] = [];

  constructor(private readonly windowSize = 20) {}

  record(atMs: number = Date.now()): void {
    this.completions.push(atMs);
    if (this.completions.length > this.windowSize) this.completions.shift();
  }

  /** Products per minute over the window, or 0 when there is not enough data. */
  perMinute(): number {
    if (this.completions.length < 2) return 0;
    const first = this.completions[0]!;
    const last = this.completions[this.completions.length - 1]!;
    const spanMs = last - first;
    if (spanMs <= 0) return 0;
    // n samples span n-1 intervals.
    return ((this.completions.length - 1) / spanMs) * 60_000;
  }

  /** ETA in ms for `remaining` products, or null when the rate is unknown. */
  estimateRemainingMs(remaining: number): number | null {
    const rate = this.perMinute();
    if (rate <= 0 || remaining <= 0) return remaining <= 0 ? 0 : null;
    return (remaining / rate) * 60_000;
  }

  reset(): void {
    this.completions.length = 0;
  }
}

/** Accumulates run time across pause gaps and process restarts. */
export class Stopwatch {
  private startedAt: number | null = null;

  constructor(private accumulatedMs = 0) {}

  start(): void {
    if (this.startedAt === null) this.startedAt = Date.now();
  }

  /** Fold the current segment into the accumulated total and stop counting. */
  stop(): number {
    if (this.startedAt !== null) {
      this.accumulatedMs += Date.now() - this.startedAt;
      this.startedAt = null;
    }
    return this.accumulatedMs;
  }

  elapsedMs(): number {
    return this.accumulatedMs + (this.startedAt === null ? 0 : Date.now() - this.startedAt);
  }

  reset(accumulatedMs = 0): void {
    this.accumulatedMs = accumulatedMs;
    this.startedAt = null;
  }
}
