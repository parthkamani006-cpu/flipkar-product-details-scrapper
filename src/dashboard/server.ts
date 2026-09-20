import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { JobRunner } from "../jobs/JobRunner.js";
import { logger } from "../logger/logger.js";
import { ensureDirs } from "../utils/paths.js";
import { exportRoutes } from "./routes/exports.js";
import { failureRoutes } from "./routes/failures.js";
import { jobRoutes } from "./routes/job.js";
import { logRoutes } from "./routes/logs.js";
import { productRoutes } from "./routes/products.js";
import { SseHub } from "./sse.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface ServerHandle {
  port: number;
  runner: JobRunner;
  close: () => Promise<void>;
}

/**
 * Wire the dashboard: REST for queries and commands, SSE for live push, and a
 * static single-page UI. The runner is created here and shared by every route,
 * so the browser and the terminal see the same job state.
 */
export async function startServer(port = 4300): Promise<ServerHandle> {
  ensureDirs();

  const app = express();
  const runner = new JobRunner();
  const hub = new SseHub();

  // ---- live push -------------------------------------------------------
  runner.on("stats", (stats) => hub.send("stats", stats));
  runner.on("product", (product) => hub.send("product", product));
  runner.on("failure", (failure) => hub.send("failure", failure));
  runner.on("export", (info) => hub.send("export", info));
  runner.on("status", (status) => hub.send("status", { status }));
  logger.subscribe((entry) => hub.send("log", entry));

  const heartbeat = setInterval(() => hub.heartbeat(), 25_000);

  app.get("/api/stream", (req, res) => {
    hub.handle(req, res);
    // Seed the newly-connected browser so it renders immediately.
    res.write(`event: stats\ndata: ${JSON.stringify(runner.stats())}\n\n`);
  });

  // ---- REST ------------------------------------------------------------
  app.use("/api", jobRoutes(runner));
  app.use("/api", productRoutes(runner));
  app.use("/api", failureRoutes(runner));
  app.use("/api", exportRoutes(runner));
  app.use("/api", logRoutes());

  // ---- static UI -------------------------------------------------------
  app.use(express.static(path.join(HERE, "public")));

  const server = app.listen(port);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  return {
    port,
    runner,
    close: async () => {
      clearInterval(heartbeat);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
