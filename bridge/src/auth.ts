// Shared bearer-token auth. Applied to EVERY route (no endpoint is exempt). The check is
// length-independent constant-time: we SHA-256 both the presented token and the expected one to
// fixed 32-byte digests, then timingSafeEqual the digests. Hashing first means neither the work
// done nor the buffer sizes depend on the candidate's length, so the comparison can't leak the
// token length via timing. Missing/wrong/oversized token -> 401.

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import type { RateLimiter } from "./rateLimit.js";

// Cap on the Authorization header we'll even hash. A legit `Bearer <token>` is well under this;
// anything larger is rejected up front so an attacker can't make us hash megabytes per request.
const MAX_AUTH_HEADER = 4096;

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

const expectedDigest = sha256(config.token);

function constantTimeEqual(presented: string): boolean {
  // Both digests are exactly 32 bytes regardless of input length, so timingSafeEqual never throws
  // on a length mismatch and the work is independent of the presented token's length.
  return timingSafeEqual(sha256(presented), expectedDigest);
}

// Built as a factory so an auth failure can be charged to the limiter's tighter "sensitive"
// bucket — that blunts token brute-force (a flood of bad tokens hits 429 before it can probe).
export function makeRequireAuth(limiter: RateLimiter) {
  return function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.get("authorization") || "";
    const ok =
      header.length <= MAX_AUTH_HEADER &&
      (() => {
        const match = /^Bearer (.+)$/.exec(header);
        const presented = match?.[1]?.trim() ?? "";
        return presented !== "" && constantTimeEqual(presented);
      })();
    if (ok) {
      next();
      return;
    }
    // Charge the failure against the sensitive budget. If that budget is already spent, answer
    // 429 instead of 401 so a brute-forcer is rate-limited, not merely rejected.
    const withinBudget = limiter.noteAuthFailure(req, config.rateSensitiveMax);
    res.status(withinBudget ? 401 : 429).json({ error: withinBudget ? "unauthorized" : "rate_limited" });
  };
}
