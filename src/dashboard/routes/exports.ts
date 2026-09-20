import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import type { JobRunner } from "../../jobs/JobRunner.js";
import { EXPORT_DIR } from "../../utils/paths.js";

/** Excel generation + download, and the log download. */
export function exportRoutes(runner: JobRunner): Router {
  const router = Router();
  router.use(express.json());

  /** Every workbook currently on disk, newest first. */
  router.get("/exports", (_req, res) => {
    if (!fs.existsSync(EXPORT_DIR)) {
      res.json({ files: [] });
      return;
    }
    const files = fs
      .readdirSync(EXPORT_DIR)
      .filter((name) => name.endsWith(".xlsx"))
      .map((name) => {
        const stat = fs.statSync(path.join(EXPORT_DIR, name));
        return { name, size: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    res.json({ files });
  });

  /** Regenerate page-N.xlsx on demand (the automatic one fires at page end). */
  router.post("/exports/page/:page", async (req, res) => {
    const pageNo = Number.parseInt(req.params.page ?? "", 10);
    if (!Number.isFinite(pageNo) || pageNo < 1) {
      res.status(400).json({ ok: false, error: "Page must be a positive integer." });
      return;
    }
    try {
      const result = await runner.exportPageNow(pageNo);
      res.json({ ok: true, file: path.basename(result.path), rows: result.rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Merge every page into one workbook. */
  router.post("/exports/all", async (_req, res) => {
    try {
      const result = await runner.exportAllNow();
      res.json({ ok: true, file: path.basename(result.path), rows: result.rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Download a generated workbook. `express.static` resolves inside EXPORT_DIR
  // only, so a crafted filename cannot escape the directory.
  router.use("/exports/download", express.static(EXPORT_DIR, { fallthrough: false }));

  return router;
}
