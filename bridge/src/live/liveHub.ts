// SSE live channel. The app's live feed (mobile twin of the desktop dashboard) subscribes here
// and receives frames as events/approvals happen. SSE chosen over WebSocket: the feed is
// one-directional (bridge -> app), simpler to run behind a tunnel, and auto-reconnects.
//
// Every frame is a JSON `LiveFrame`. We send a periodic ping so idle proxies/tunnels don't drop
// the connection. Auth is enforced by the route before subscribe() is ever called.
//
// Subscriber count is capped (overall and per source IP) so GET /v1/live can't be used to
// exhaust sockets/heap — a refused subscribe answers 429.

import type { Response } from "express";
import type { LiveFrame } from "../contracts/index.js";

export class LiveHub {
  private readonly clients = new Set<Response>();
  // Track the source IP of each client so we can enforce a per-IP cap and decrement on close.
  private readonly clientIp = new Map<Response, string>();
  private readonly perIpCount = new Map<string, number>();
  private readonly maxClients: number;
  private readonly maxPerIp: number;
  private readonly pingTimer: NodeJS.Timeout;

  constructor(opts: { pingMs?: number; maxClients?: number; maxPerIp?: number } = {}) {
    const pingMs = opts.pingMs ?? 25_000;
    this.maxClients = opts.maxClients ?? 50;
    this.maxPerIp = opts.maxPerIp ?? 5;
    this.pingTimer = setInterval(() => {
      this.broadcast({ type: "ping", at: new Date().toISOString() });
    }, pingMs);
    // Don't keep the process alive solely for pings.
    this.pingTimer.unref?.();
  }

  // Attach an already-authenticated SSE response. Caller has set the SSE headers. Returns false
  // if a cap (overall or per-IP) is hit — the route then answers 429 instead of streaming.
  subscribe(res: Response, ip: string): boolean {
    if (this.clients.size >= this.maxClients) return false;
    if ((this.perIpCount.get(ip) ?? 0) >= this.maxPerIp) return false;
    this.clients.add(res);
    this.clientIp.set(res, ip);
    this.perIpCount.set(ip, (this.perIpCount.get(ip) ?? 0) + 1);
    res.on("close", () => this.drop(res));
    return true;
  }

  private drop(res: Response): void {
    if (!this.clients.delete(res)) return;
    const ip = this.clientIp.get(res);
    this.clientIp.delete(res);
    if (ip !== undefined) {
      const n = (this.perIpCount.get(ip) ?? 1) - 1;
      if (n <= 0) this.perIpCount.delete(ip);
      else this.perIpCount.set(ip, n);
    }
  }

  broadcast(frame: LiveFrame): void {
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        // Dead socket — drop it; "close" will also fire.
        this.drop(res);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}
