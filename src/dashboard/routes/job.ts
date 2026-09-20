import express, { Router } from "express";
import type { JobRunner } from "../../jobs/JobRunner.js";
import { toNumberOrNull } from "../../utils/format.js";

/** Start / Pause / Resume / Stop plus the stats + checkpoint snapshots. */
export function jobRoutes(runner: JobRunner): Router {
  const router = Router();
  router.use(express.json());

  /** Snapshot for a browser that just connected (SSE covers everything after). */
  router.get("/job/stats", (_req, res) => {
    res.json({
      stats: runner.stats(),
      checkpoint: runner.checkpoint.get(),
      canResume: runner.canResume(),
    });
  });

  router.get("/job/checkpoint", (_req, res) => {
    res.json(runner.checkpoint.get());
  });

  router.post("/job/start", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    const startPage = toNumberOrNull(body.startPage) ?? 0;
    const endPage = toNumberOrNull(body.endPage) ?? 0;

    try {
      runner.start({
        keyword,
        startPage,
        endPage,
        fresh: body.fresh === true,
        captureLatchOn: body.captureLatchOn !== false,
      });
      res.json({ ok: true, stats: runner.stats() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // pause / resume / stop share one shape: 200 with stats, or 409 + reason.
  for (const action of ["pause", "resume", "stop"] as const) {
    router.post(`/job/${action}`, (_req, res) => {
      try {
        runner[action]();
        res.json({ ok: true, stats: runner.stats() });
      } catch (err) {
        res.status(409).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  return router;
}
