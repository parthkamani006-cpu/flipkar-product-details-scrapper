import { FAILURES_FILE } from "../utils/paths.js";
import { JsonlStore } from "./jsonlStore.js";
import type { FailureRecord, FailureStatus } from "./types.js";

/** Stable failure id, so retries update the same row instead of duplicating it. */
export function failureId(page: number, pid: string, url: string): string {
  return `${page}:${pid || url}`;
}

/**
 * Durable store of every product that failed, with the full diagnostic payload
 * (stage, classified error type, raw message, stack, screenshot, retry count).
 * Nothing is ever silently dropped.
 */
export class FailureStore {
  private readonly store = new JsonlStore<FailureRecord>(FAILURES_FILE, (r) => r.id);

  /**
   * Record a failure. If the same product failed before, the retry count is
   * carried forward so the UI shows how many attempts it has had.
   */
  save(record: Omit<FailureRecord, "retryCount"> & { retryCount?: number }): FailureRecord {
    const previous = this.store.get(record.id);
    const full: FailureRecord = {
      ...record,
      retryCount: record.retryCount ?? (previous ? previous.retryCount + 1 : 0),
    };
    this.store.append(full);
    return full;
  }

  /** Flip a failure's status (e.g. to "retrying" or "resolved"). */
  setStatus(id: string, status: FailureStatus): FailureRecord | undefined {
    const existing = this.store.get(id);
    if (!existing) return undefined;
    const updated: FailureRecord = { ...existing, status };
    this.store.append(updated);
    return updated;
  }

  /** Mark as resolved — used when a retry finally succeeds. */
  resolve(id: string): void {
    this.setStatus(id, "resolved");
  }

  all(): readonly FailureRecord[] {
    return this.store.all();
  }

  /** Failures still needing attention (i.e. not resolved). */
  outstanding(): FailureRecord[] {
    return this.store.all().filter((r) => r.status !== "resolved");
  }

  get(id: string): FailureRecord | undefined {
    return this.store.get(id);
  }

  clear(): void {
    this.store.clear();
  }
}
