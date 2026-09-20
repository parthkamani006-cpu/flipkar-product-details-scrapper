import express, { Router } from "express";
import type { JobRunner } from "../../jobs/JobRunner.js";
import { SCREENSHOT_DIR } from "../../utils/paths.js";

/** Failed-products page: listing, retry commands, and screenshot serving. */
export function failureRoutes(runner: JobRunner): Router {
  const router = Router();

  // GET /api/failures?status=failed&errorType=Navigation%20Timeout
  router.get("/failures", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const errorType = typeof req.query.errorType === "string" ? req.query.errorType : undefined;
    const search =
      typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : undefined;

    let rows = [...runner.failures.all()];
    if (status && status !== "all") rows = rows.filter((r) => r.status === status);
    if (errorType && errorType !== "all") rows = rows.filter((r) => r.errorType === errorType);
    if (search) {
      rows = rows.filter((r) =>
        `${r.fsn ?? ""} ${r.pid} ${r.url} ${r.message}`.toLowerCase().includes(search),
      );
    }

    rows.sort((a, b) => b.failedAt.localeCompare(a.failedAt));

    const errorTypes = [...new Set(runner.failures.all().map((r) => r.errorType))].sort();
    res.json({ rows, total: rows.length, errorTypes });
  });

  /** Retry: no body -> every outstanding failure; { ids: [...] } -> a subset. */
  router.post("/failures/retry", express.json(), async (req, res) => {
    const body = req.body as { ids?: unknown } | undefined;
    const ids = Array.isArray(body?.ids) ? body.ids.map(String) : undefined;
    try {
      const result = await runner.retry(ids);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(409).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Failure screenshots, served read-only from the data dir.
  router.use("/screenshots", express.static(SCREENSHOT_DIR, { fallthrough: false }));

  return router;
}
