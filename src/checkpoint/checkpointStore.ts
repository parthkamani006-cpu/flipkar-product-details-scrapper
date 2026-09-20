import fs from "node:fs";
import { CHECKPOINT_FILE } from "../utils/paths.js";
import { atomicWriteJsonSync } from "../utils/atomicWrite.js";

/**
 * Crash-recovery checkpoint.
 *
 * This records WHERE the run was; the product store records WHAT is already
 * done. Splitting the two matters: even if the checkpoint is stale by one
 * product, the resume still cannot re-scrape anything, because every candidate
 * is checked against the product store before being scraped.
 */
export interface Checkpoint {
  jobId: string;
  keyword: string;
  startPage: number;
  endPage: number;
  /** The listing URL Flipkart produced for the search, reused on resume. */
  searchUrl: string | null;

  currentPage: number | null;
  currentProduct: number | null;
  currentProductLabel: string | null;

  completedPages: number[];
  /** Pages whose page-N.xlsx already exists — never regenerated. */
  excelGeneratedPages: number[];

  completedProducts: number;
  successCount: number;
  failedCount: number;

  /** Products seen on each page, so totals survive a restart. */
  productsPerPage: Record<string, number>;

  startedAt: string;
  updatedAt: string;
  /** Accumulated run time across all sessions, excluding paused/stopped gaps. */
  elapsedMs: number;
  status: "idle" | "running" | "paused" | "stopped" | "completed" | "failed";
}

export function emptyCheckpoint(): Checkpoint {
  const now = new Date().toISOString();
  return {
    jobId: "",
    keyword: "",
    startPage: 0,
    endPage: 0,
    searchUrl: null,
    currentPage: null,
    currentProduct: null,
    currentProductLabel: null,
    completedPages: [],
    excelGeneratedPages: [],
    completedProducts: 0,
    successCount: 0,
    failedCount: 0,
    productsPerPage: {},
    startedAt: now,
    updatedAt: now,
    elapsedMs: 0,
    status: "idle",
  };
}

/** Reads/writes the single checkpoint file atomically. */
export class CheckpointStore {
  private current: Checkpoint;

  constructor() {
    this.current = this.read() ?? emptyCheckpoint();
  }

  private read(): Checkpoint | null {
    if (!fs.existsSync(CHECKPOINT_FILE)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8")) as Partial<Checkpoint>;
      // Merge over the default so a checkpoint written by an older build
      // (missing a field) still loads instead of crashing the resume.
      return { ...emptyCheckpoint(), ...parsed };
    } catch {
      // Should be impossible thanks to the atomic write, but never let a bad
      // checkpoint stop the app from starting.
      return null;
    }
  }

  get(): Checkpoint {
    return this.current;
  }

  /** Merge a patch and flush to disk atomically. Called after every product. */
  update(patch: Partial<Checkpoint>): Checkpoint {
    this.current = {
      ...this.current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteJsonSync(CHECKPOINT_FILE, this.current);
    return this.current;
  }

  markPageComplete(pageNo: number): void {
    if (this.current.completedPages.includes(pageNo)) return;
    this.update({ completedPages: [...this.current.completedPages, pageNo].sort((a, b) => a - b) });
  }

  markExcelGenerated(pageNo: number): void {
    if (this.current.excelGeneratedPages.includes(pageNo)) return;
    this.update({
      excelGeneratedPages: [...this.current.excelGeneratedPages, pageNo].sort((a, b) => a - b),
    });
  }

  isPageComplete(pageNo: number): boolean {
    return this.current.completedPages.includes(pageNo);
  }

  isExcelGenerated(pageNo: number): boolean {
    return this.current.excelGeneratedPages.includes(pageNo);
  }

  /** Wipe the checkpoint — only used by an explicit "start fresh". */
  reset(): Checkpoint {
    this.current = emptyCheckpoint();
    atomicWriteJsonSync(CHECKPOINT_FILE, this.current);
    return this.current;
  }
}
