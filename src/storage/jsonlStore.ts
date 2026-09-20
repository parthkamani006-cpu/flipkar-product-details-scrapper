import fs from "node:fs";
import path from "node:path";

/**
 * Append-only JSONL store with an in-memory index.
 *
 * WHY JSONL: the durability requirement is "every product is persisted the
 * instant it is scraped, and a crash loses nothing". A single
 * `appendFileSync` of one line is the cheapest operation that satisfies that —
 * it never rewrites existing bytes, so a crash can at worst truncate the final
 * line (which `load()` discards). Rewriting a whole JSON array per product
 * would be O(n) per write and leaves a window where the file is invalid.
 *
 * Reads are served from the in-memory array, so filtering/sorting thousands of
 * rows never touches disk.
 */
export class JsonlStore<T extends object> {
  private rows: T[] = [];
  private readonly keyOf: (row: T) => string;
  private readonly index = new Map<string, number>();

  constructor(
    private readonly filePath: string,
    keyOf: (row: T) => string,
  ) {
    this.keyOf = keyOf;
    this.load();
  }

  /**
   * Read the file back into memory. A trailing partial line (torn by a crash
   * mid-append) fails to parse and is dropped — that product simply looks
   * un-scraped and gets picked up again on resume.
   */
  private load(): void {
    this.rows = [];
    this.index.clear();
    if (!fs.existsSync(this.filePath)) return;

    const text = fs.readFileSync(this.filePath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const row = JSON.parse(trimmed) as T;
        this.put(row);
      } catch {
        // Torn final line, or hand-edited garbage — skip it.
      }
    }
  }

  /** Insert-or-replace in the in-memory view only. */
  private put(row: T): void {
    const key = this.keyOf(row);
    const at = this.index.get(key);
    if (at === undefined) {
      this.index.set(key, this.rows.length);
      this.rows.push(row);
    } else {
      this.rows[at] = row;
    }
  }

  /**
   * Persist one row immediately, then update the in-memory view.
   *
   * Appending a later row with the same key acts as an update: `load()`
   * replays in order, so the last line for a key wins.
   */
  append(row: T): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, "utf8");
    this.put(row);
  }

  /** All rows, in insertion order. Do not mutate. */
  all(): readonly T[] {
    return this.rows;
  }

  count(): number {
    return this.rows.length;
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  get(key: string): T | undefined {
    const at = this.index.get(key);
    return at === undefined ? undefined : this.rows[at];
  }

  keys(): Set<string> {
    return new Set(this.index.keys());
  }

  /** Delete the backing file and reset — used by "start fresh". */
  clear(): void {
    if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath);
    this.rows = [];
    this.index.clear();
  }
}
