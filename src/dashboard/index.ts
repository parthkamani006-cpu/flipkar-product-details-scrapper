import { startServer } from "./server.js";

/** Entry point for `npm run dashboard`. */
const port = Number.parseInt(process.env.PORT ?? "4300", 10);

startServer(Number.isFinite(port) ? port : 4300)
  .then((handle) => {
    console.error(
      [
        "",
        "  Flipkart Scraper — dashboard running",
        `  http://localhost:${handle.port}`,
        "",
        "  Press Ctrl+C to stop the server (a running job is checkpointed and resumable).",
        "",
      ].join("\n"),
    );
  })
  .catch((err: unknown) => {
    console.error("Failed to start the dashboard:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
