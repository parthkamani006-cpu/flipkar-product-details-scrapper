import type { Request, Response } from "express";

/**
 * Server-Sent Events hub.
 *
 * SSE (not WebSockets) because the traffic is strictly one-directional —
 * server pushes, browser listens — and EventSource reconnects on its own, so a
 * dashboard left open overnight recovers from a server restart without any
 * client-side retry logic. Commands travel over ordinary POST routes.
 */
export class SseHub {
  private readonly clients = new Set<Response>();

  /** Attach a new client. Keeps the connection open until the browser leaves. */
  handle(req: Request, res: Response): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defeat proxy buffering, which would otherwise delay events.
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");

    this.clients.add(res);
    req.on("close", () => {
      this.clients.delete(res);
    });
  }

  /** Broadcast one named event to every connected dashboard. */
  send(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Comment frame that keeps idle connections alive through proxies. */
  heartbeat(): void {
    for (const client of this.clients) {
      try {
        client.write(": ping\n\n");
      } catch {
        this.clients.delete(client);
      }
    }
  }

  size(): number {
    return this.clients.size;
  }
}
