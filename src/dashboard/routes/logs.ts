import fs from "node:fs";
import { Router } from "express";
import { logger } from "../../logger/logger.js";
import { toNumberOrNull } from "../../utils/format.js";

/** Recent log tail for the UI, plus a full download of the JSONL file. */
export function logRoutes(): Router {
  const router = Router();

  router.get("/logs", (req, res) => {
    const limit = toNumberOrNull(req.query.limit) ?? 200;
    res.json({ entries: logger.tail(limit) });
  });

  /** Download the complete structured log. */
  router.get("/logs/download", (_req, res) => {
    const file = logger.logFilePath();
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "No log file has been written yet." });
      return;
    }
    res.download(file, "scraper-log.jsonl");
  });

  return router;
}
