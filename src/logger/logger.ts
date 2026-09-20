import fs from "node:fs";
import path from "node:path";
import { LOG_FILE } from "../utils/paths.js";
import type { LogEntry, LogEventName, LogLevel } from "./events.js";

type Listener = (entry: LogEntry) => void;

/**
 * Append-only structured logger.
 *
 * Every event is one JSON object on one line (JSONL): cheap to append, safe
 * across a crash, trivially greppable, and streamable to the dashboard as it is
 * written. A bounded ring of recent entries is kept in memory so a browser that
 * connects late can still render the tail of the log.
 */
export class Logger {
  private readonly recent: LogEntry[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly filePath = LOG_FILE,
    private readonly recentLimit = 500,
  ) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  log(level: LogLevel, event: LogEventName, message: string, data?: Record<string, unknown>): LogEntry {
    const entry: LogEntry = { ts: new Date().toISOString(), level, event, message, ...(data ? { data } : {}) };

    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Logging must never be able to kill a scrape.
    }

    this.recent.push(entry);
    if (this.recent.length > this.recentLimit) this.recent.shift();

    // Mirror to the console so the terminal stays useful on its own.
    const line = `[${entry.level.toUpperCase()}] ${entry.event} — ${entry.message}`;
    if (level === "error") console.error(line);
    else console.error(line);

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A broken SSE client must not break logging.
      }
    }
    return entry;
  }

  info(event: LogEventName, message: string, data?: Record<string, unknown>): void {
    this.log("info", event, message, data);
  }
  warn(event: LogEventName, message: string, data?: Record<string, unknown>): void {
    this.log("warn", event, message, data);
  }
  error(event: LogEventName, message: string, data?: Record<string, unknown>): void {
    this.log("error", event, message, data);
  }

  /** Subscribe to live entries; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  tail(limit = 200): LogEntry[] {
    return this.recent.slice(-limit);
  }

  logFilePath(): string {
    return this.filePath;
  }
}

/** One logger per process — the dashboard and the runner share it. */
export const logger = new Logger();
