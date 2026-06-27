// Tiny in-memory per-IP rate limiter. No dependency — fits the lean single-operator MVP and the
// loopback-only posture. Two buckets share one limiter so brute-force on a sensitive route
// (resolve, or any auth failure) draws down a tighter budget than ordinary traffic.
//
// Fixed-window counters keyed by IP. Stale windows are reclaimed lazily on access plus a periodic
// sweep so the map can't grow unbounded under a churn of source IPs. Over the limit -> 429
// { error: "rate_limited" }.

import type { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number; // epoch ms when the current window rolls over
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(opts: { windowMs: number }) {
    this.windowMs = opts.windowMs;
    this.sweepTimer = setInterval(() => this.sweep(), this.windowMs);
    this.sweepTimer.unref?.();
  }

  // Returns true if this hit is allowed (and counts it), false if the IP is over `max`.
  private take(key: string, max: number, now: number): boolean {
    let b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    if (b.count >= max) return false;
    b.count += 1;
    return true;
  }

  private sweep(now = Date.now()): void {
    for (const [key, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(key);
    }
  }

  private clientKey(req: Request): string {
    // Loopback default; trust the socket address, not spoofable forwarding headers.
    return req.socket.remoteAddress ?? "unknown";
  }

  // Middleware factory. `sensitive` buckets a route separately under the tighter `sensitiveMax`,
  // so sensitive traffic can't be masked by a generous global budget.
  middleware(opts: { max: number; sensitiveMax: number }) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const now = Date.now();
      const ip = this.clientKey(req);
      const isSensitive = /\/resolve$/.test(req.path);
      const key = isSensitive ? `s:${ip}` : `g:${ip}`;
      const max = isSensitive ? opts.sensitiveMax : opts.max;
      if (!this.take(key, max, now)) {
        res.status(429).json({ error: "rate_limited" });
        return;
      }
      next();
    };
  }

  // Count an auth failure against the tighter sensitive bucket to blunt token brute-force.
  // Returns true if the failure is still within budget (caller should answer 401); false if the
  // IP has burned its sensitive budget on failures (caller should answer 429 instead).
  noteAuthFailure(req: Request, sensitiveMax: number): boolean {
    return this.take(`s:${this.clientKey(req)}`, sensitiveMax, Date.now());
  }
}
