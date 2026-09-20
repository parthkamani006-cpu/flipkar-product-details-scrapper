/** The structured event vocabulary. One constant per lifecycle moment. */
export const LogEvent = {
  JOB_STARTED: "job.started",
  JOB_RESUMED: "job.resumed",
  JOB_PAUSED: "job.paused",
  JOB_STOPPED: "job.stopped",
  JOB_FINISHED: "job.finished",
  JOB_FAILED: "job.failed",

  PAGE_STARTED: "page.started",
  PAGE_SKIPPED: "page.skipped",
  PAGE_COMPLETED: "page.completed",

  PRODUCT_STARTED: "product.started",
  PRODUCT_COMPLETED: "product.completed",
  PRODUCT_FAILED: "product.failed",
  PRODUCT_SKIPPED: "product.skipped",

  CHECKPOINT_SAVED: "checkpoint.saved",
  EXCEL_GENERATED: "excel.generated",
  SCREENSHOT_SAVED: "screenshot.saved",

  RETRY_STARTED: "retry.started",
  RETRY_FINISHED: "retry.finished",
  BROWSER_LAUNCHED: "browser.launched",
  SEARCH_SUBMITTED: "search.submitted",
} as const;

export type LogEventName = (typeof LogEvent)[keyof typeof LogEvent];
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: LogEventName;
  message: string;
  /** Arbitrary structured context (page number, pid, durations, ...). */
  data?: Record<string, unknown>;
}
