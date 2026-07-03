// Bridge service entry point. Wires the stores, auth, routes, and live channel, then listens.
//
// SECURITY POSTURE:
//   - Binds to 127.0.0.1 by default. The bridge is the trust boundary and must NOT be an open
//     public endpoint — expose it only behind an authenticated tunnel / private network.
//   - EVERY route is behind requireAuth (constant-time bearer check). No exempt endpoint.
//   - Refuses to start without BRIDGE_TOKEN (see config.ts) — a tokenless gate is not a gate.
//   - Only redacted summaries are ever stored/logged/pushed (see redact.ts).

import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { makeRequireAuth } from "./auth.js";
import { RateLimiter } from "./rateLimit.js";
import { buildRouter } from "./routes.js";
import { ApprovalStore } from "./store/approvalStore.js";
import { GrantStore } from "./store/grantStore.js";
import { EventStore } from "./store/eventStore.js";
import { DeviceStore } from "./store/deviceStore.js";
import { ExpoPush } from "./push/expoPush.js";
import { LiveHub } from "./live/liveHub.js";
import { createTelegramChannel } from "./telegram/poller.js";

export function createApp() {
  const approvals = new ApprovalStore({
    ttlMs: config.approvalTtlMs,
    retainMs: config.approvalRetainMs
  });
  const grants = new GrantStore({
    ttlMs: config.approvalTtlMs,
    retainMs: config.approvalRetainMs,
    grantTtlMs: config.grantTtlMs
  });
  const events = new EventStore({ max: config.eventBufferMax });
  const devices = new DeviceStore({ max: config.deviceMax });
  const push = new ExpoPush({ url: config.expoPushUrl, devices });
  const live = new LiveHub({
    maxClients: config.liveMaxClients,
    maxPerIp: config.liveMaxPerIp
  });
  const limiter = new RateLimiter({ windowMs: config.rateWindowMs });

  // Telegram remote-approval channel — opt-in (null unless TELEGRAM_BOT_TOKEN is set). Purely
  // additive: it resolves through the same store and never gates. The poll loop is NOT started
  // here so createApp() in tests spawns no network loop; only the isMain block below starts it.
  const telegram = config.telegramEnabled
    ? createTelegramChannel({ approvals, grants, events, live, config })
    : null;

  // Periodically drop stale terminal/expired approvals + grants.
  const sweepTimer = setInterval(() => {
    approvals.sweep();
    grants.sweep();
  }, 30_000);
  sweepTimer.unref?.();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // Version header on every response so clients can detect drift.
  app.use((_req, res, next) => {
    res.set("X-Bridge-Version", "1");
    next();
  });

  // Per-IP rate limit first (caps unauth'd floods too), then auth on EVERY request, then the
  // versioned router. The resolve route + auth failures draw down the tighter "sensitive" bucket.
  app.use(
    "/v1",
    limiter.middleware({ max: config.rateMax, sensitiveMax: config.rateSensitiveMax }),
    makeRequireAuth(limiter),
    buildRouter({ approvals, grants, events, devices, push, live, telegram })
  );

  // Mobile web approval page (PUBLIC — outside /v1, NOT behind requireAuth). The HTML/JS carry no
  // secrets; the user enters the bridge token at runtime and it's only ever sent on /v1 calls,
  // which stay fully auth-gated above. Resolve public/ relative to this module (ESM, no __dirname):
  // src/server.ts -> ../public. Mounted AFTER /v1 and BEFORE the catch-all 404.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  app.use(express.static(publicDir));
  app.get("/", (_req, res) => {
    res.sendFile(join(publicDir, "index.html"));
  });

  // Reject anything unmatched (also auth-agnostic 404, no info leak).
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // JSON body-parse errors -> bad_request (default-deny posture: never crash on bad input).
  app.use(
    (
      err: Error & { type?: string; status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (err?.type === "entity.parse.failed" || err?.status === 400) {
        res.status(400).json({ error: "bad_request", message: "invalid JSON body" });
        return;
      }
      console.error(`[bridge] internal error: ${err?.name ?? "error"}`);
      res.status(500).json({ error: "internal" });
    }
  );

  // `telegram` is returned for test shutdown; its poll loop is started only in isMain below.
  return { app, stores: { approvals, events, devices }, telegram };
}

// Start the server unless imported (e.g. by tests).
const entry = process.argv[1] ?? "";
const isMain = import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  const { app, telegram } = createApp();
  // Only the real process starts the network poll loop (tests never spawn it).
  telegram?.start();
  app.listen(config.port, config.host, () => {
    console.log(`[bridge] listening on http://${config.host}:${config.port} (v1)`);
  });
}
