// REST + SSE routes. All mounted under /v1 and behind requireAuth (see server.ts).
//
// Endpoints:
//   POST /v1/approvals            (hook)  create a pending approval -> { requestId, ... }
//   GET  /v1/approvals            (app)   list approvals
//   GET  /v1/approvals/:id        (hook)  poll one approval status
//   POST /v1/approvals/:id/resolve(app)   resolve allow|deny
//   GET  /v1/events               (app)   list recent events
//   POST /v1/events               (hook notify.mjs) append a report event
//   POST /v1/register             (app)   register an Expo push token
//   GET  /v1/live                 (app)   SSE live channel
//   GET  /v1/healthz                      liveness (still auth-gated per spec)

import { Router, type Request, type Response } from "express";
import type {
  ApprovalView,
  BatchView,
  CoverageRequest,
  CoverageResponse,
  CreateApprovalRequest,
  CreateApprovalResponse,
  CreateBatchRequest,
  CreateBatchResponse,
  CreateEventRequest,
  Decision,
  EventKind,
  EventSeverity,
  RegisterDeviceRequest,
  ResolveApprovalRequest
} from "./contracts/index.js";
import type { ApprovalStore } from "./store/approvalStore.js";
import type { GrantStore } from "./store/grantStore.js";
import type { EventStore } from "./store/eventStore.js";
import type { DeviceStore } from "./store/deviceStore.js";
import type { ExpoPush } from "./push/expoPush.js";
import type { LiveHub } from "./live/liveHub.js";
import type { TelegramChannel } from "./telegram/poller.js";
import { config } from "./config.js";
import { buildSummary, clampLine, coerceSafeInput } from "./redact.js";

// Shared side-effects run after a SUCCESSFUL resolve, regardless of which channel resolved it
// (the HTTP /resolve route or the Telegram button). Kept here so the two callers can't drift:
// record the redacted Decision in the feed + broadcast both frames over SSE.
export function notifyResolved(
  deps: { events: EventStore; live: LiveHub },
  view: ApprovalView,
  decision: Decision
): void {
  const ev = deps.events.append({
    kind: "Decision",
    message: `${view.tool} ${decision === "allow" ? "승인됨" : "거부됨"}: ${view.summary}`,
    severity: decision === "allow" ? "info" : "warn",
    source: view.sessionId
  });
  deps.live.broadcast({ type: "event", event: ev });
  deps.live.broadcast({ type: "approval", approval: view });
}

const EVENT_KINDS = new Set<EventKind>([
  "SubagentStop",
  "Notification",
  "PostToolUse",
  "Decision",
  "ApprovalRequest"
]);
const SEVERITIES = new Set<EventSeverity>(["info", "warn", "error"]);

export interface Deps {
  approvals: ApprovalStore;
  grants: GrantStore;
  events: EventStore;
  devices: DeviceStore;
  push: ExpoPush;
  live: LiveHub;
  // Optional Telegram channel (null when TELEGRAM_BOT_TOKEN is unset — pure v1).
  telegram: TelegramChannel | null;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: "bad_request", message });
}

// Coerce an unknown into a bounded array of clamped non-empty strings. Used for batch items/files/
// dirs so a malformed/oversized payload can never blow up memory or the Telegram card.
function stringArray(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const el of v) {
    if (typeof el !== "string") continue;
    const s = clampLine(el, maxLen);
    if (s.length > 0) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function buildRouter(deps: Deps): Router {
  const router = Router();
  const { approvals, grants, events, devices, push, live, telegram } = deps;

  // Liveness. Auth-gated per the spec (no exempt endpoint).
  router.get("/healthz", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // ---- Approvals: create (hook) ----
  router.post("/approvals", (req: Request, res: Response) => {
    const body = req.body as Partial<CreateApprovalRequest> | undefined;
    if (!body || typeof body.tool !== "string" || typeof body.sessionId !== "string") {
      return badRequest(res, "tool and sessionId are required");
    }
    // Cap PENDING approvals so a flood of unresolved creates can't exhaust heap (DoS).
    if (approvals.pendingCount() >= config.approvalMaxPending) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    // Derive the redacted, value-free display summary HERE. We never store the raw inputSummary.
    const summary = buildSummary(body.tool, body.inputSummary);
    // Validate the structured safe partial (already value-free) for the richer Telegram card.
    // Backward-tolerant: an old/missing/unknown shape -> undefined -> card falls back gracefully.
    const safeInput = coerceSafeInput(body.inputSummary);
    const view = approvals.create({
      tool: clampLine(body.tool, 60),
      summary,
      safeInput,
      cwd: typeof body.cwd === "string" ? clampLine(body.cwd, 200) : undefined,
      sessionId: clampLine(body.sessionId, 80)
    });

    // Push + live nudge (best-effort; never blocks or affects the gate).
    void push.send({
      title: "승인 요청",
      body: `${view.tool} — ${view.summary}`,
      data: { kind: "approval", requestId: view.requestId }
    });
    live.broadcast({ type: "approval", approval: view });
    // Telegram nudge (best-effort; never blocks or affects the gate — same posture as push).
    telegram?.notifyApproval(view);
    // Mirror into the feed so the live tab shows the request too.
    const ev = events.append({
      kind: "ApprovalRequest",
      message: `${view.tool} 승인 대기: ${view.summary}`,
      severity: "warn",
      source: view.sessionId
    });
    live.broadcast({ type: "event", event: ev });

    const resp: CreateApprovalResponse = {
      requestId: view.requestId,
      status: view.status,
      expiresAt: view.expiresAt
    };
    res.status(201).json(resp);
  });

  // ---- Approvals: list (app) ----
  router.get("/approvals", (_req, res) => {
    res.json({ approvals: approvals.list() });
  });

  // ---- Approvals: poll one (hook) ----
  router.get("/approvals/:id", (req, res) => {
    const view = approvals.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(view);
  });

  // ---- Approvals: resolve (app) ----
  router.post("/approvals/:id/resolve", (req, res) => {
    const body = req.body as Partial<ResolveApprovalRequest> | undefined;
    const decision = body?.decision;
    if (decision !== "allow" && decision !== "deny") {
      return badRequest(res, 'decision must be "allow" or "deny"');
    }
    const result = approvals.resolve(req.params.id, decision as Decision);
    if (!result.ok) {
      const codeMap = {
        not_found: 404,
        expired: 409,
        already_resolved: 409
      } as const;
      res.status(codeMap[result.reason]).json({ error: result.reason });
      return;
    }
    const view = result.view;
    // Shared side-effects (feed Decision + live broadcasts) — same path the Telegram button takes.
    notifyResolved({ events, live }, view, decision as Decision);
    res.json(view);
  });

  // ---- Batch 결재: create (agent) ----
  // The agent submits a rich, human-authored batch. On approve it becomes an ACTIVE GRANT that the
  // coverage route consults. NO raw tool input here — only the agent's functional summary.
  router.post("/batches", (req: Request, res: Response) => {
    const body = req.body as Partial<CreateBatchRequest> | undefined;
    if (!body || typeof body.cwd !== "string" || typeof body.title !== "string") {
      return badRequest(res, "cwd and title are required");
    }
    const items = stringArray(body.items, 40, 300);
    if (items.length === 0) {
      return badRequest(res, "items must be a non-empty array of summary lines");
    }
    const files = stringArray(body.files, 100, 400);
    const dirs = stringArray(body.dirs, 40, 400);
    const bash = body.bash === true;
    if (files.length === 0 && dirs.length === 0 && !bash) {
      return badRequest(res, "batch must cover at least one of: files, dirs, bash");
    }
    // Clamp the op budget to [1, hard cap]; default when unspecified.
    const requested =
      typeof body.maxOps === "number" && Number.isFinite(body.maxOps)
        ? Math.floor(body.maxOps)
        : config.grantDefaultOps;
    const maxOps = Math.max(1, Math.min(requested, config.grantMaxOps));

    if (grants.pendingCount() >= config.approvalMaxPending) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    const view = grants.create({
      cwd: clampLine(body.cwd, 300),
      sessionId: typeof body.sessionId === "string" ? clampLine(body.sessionId, 80) : undefined,
      title: clampLine(body.title, 200),
      items,
      files,
      dirs,
      bash,
      maxOps
    });

    void push.send({
      title: "결재 요청",
      body: `${view.title} (${items.length}건)`,
      data: { kind: "batch", batchId: view.batchId }
    });
    live.broadcast({ type: "batch", batch: view });
    telegram?.notifyBatch(view);
    const ev = events.append({
      kind: "ApprovalRequest",
      message: `결재 대기: ${view.title} (${items.length}건)`,
      severity: "warn",
      source: view.sessionId ?? view.cwd
    });
    live.broadcast({ type: "event", event: ev });

    const resp: CreateBatchResponse = {
      batchId: view.batchId,
      status: view.status,
      expiresAt: view.expiresAt
    };
    res.status(201).json(resp);
  });

  // ---- Batch 결재: list (app) ----
  router.get("/batches", (_req, res) => {
    res.json({ batches: grants.list() });
  });

  // ---- Batch 결재: poll one (agent) ----
  router.get("/batches/:id", (req, res) => {
    const view = grants.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(view);
  });

  // ---- Batch 결재: resolve (app / Telegram share the store) ----
  router.post("/batches/:id/resolve", (req, res) => {
    const body = req.body as Partial<ResolveApprovalRequest> | undefined;
    const decision = body?.decision;
    if (decision !== "allow" && decision !== "deny") {
      return badRequest(res, 'decision must be "allow" or "deny"');
    }
    const result = grants.resolve(req.params.id, decision);
    if (!result.ok) {
      const codeMap = { not_found: 404, expired: 409, already_resolved: 409 } as const;
      res.status(codeMap[result.reason]).json({ error: result.reason });
      return;
    }
    const view = result.view;
    const ev = events.append({
      kind: "Decision",
      message: `결재 ${decision === "allow" ? "승인됨" : "거부됨"}: ${view.title}`,
      severity: decision === "allow" ? "info" : "warn",
      source: view.sessionId ?? view.cwd
    });
    live.broadcast({ type: "event", event: ev });
    live.broadcast({ type: "batch", batch: view });
    res.json(view);
  });

  // ---- Coverage check (hook) ----
  // The PreToolUse hook asks whether a mutating call is covered by an active grant. Covered =>
  // atomically consume one op. Not covered / ambiguous => the hook default-denies.
  router.post("/coverage", (req: Request, res: Response) => {
    const body = req.body as Partial<CoverageRequest> | undefined;
    if (!body || typeof body.cwd !== "string" || typeof body.tool !== "string") {
      return badRequest(res, "cwd and tool are required");
    }
    const result = grants.cover({
      cwd: body.cwd,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      tool: body.tool,
      path: typeof body.path === "string" ? body.path : undefined
    });
    const resp: CoverageResponse = result;
    res.json(resp);
  });

  // ---- Events: list (app) ----
  router.get("/events", (_req, res) => {
    res.json({ events: events.list() });
  });

  // ---- Events: append (notify.mjs) ----
  router.post("/events", (req: Request, res: Response) => {
    const body = req.body as Partial<CreateEventRequest> | undefined;
    if (!body || typeof body.kind !== "string" || !EVENT_KINDS.has(body.kind as EventKind)) {
      return badRequest(res, "kind must be one of the known EventKind values");
    }
    if (typeof body.message !== "string") {
      return badRequest(res, "message is required");
    }
    const severity =
      typeof body.severity === "string" && SEVERITIES.has(body.severity as EventSeverity)
        ? (body.severity as EventSeverity)
        : "info";
    const ev = events.append({
      kind: body.kind as EventKind,
      message: clampLine(body.message),
      severity,
      source: typeof body.source === "string" ? clampLine(body.source, 80) : undefined
    });
    live.broadcast({ type: "event", event: ev });
    res.status(201).json(ev);
  });

  // ---- Register device push token (app) ----
  router.post("/register", (req: Request, res: Response) => {
    const body = req.body as Partial<RegisterDeviceRequest> | undefined;
    if (!body || typeof body.expoPushToken !== "string" || !body.expoPushToken.trim()) {
      return badRequest(res, "expoPushToken is required");
    }
    devices.register(
      body.expoPushToken.trim(),
      typeof body.label === "string" ? clampLine(body.label, 60) : undefined
    );
    res.status(201).json({ registered: true });
  });

  // ---- Live channel (SSE) ----
  router.get("/live", (req, res) => {
    // Reserve the subscriber slot BEFORE switching to SSE so a refused (capped) client gets a
    // clean 429 JSON rather than a half-open stream.
    const ip = req.socket.remoteAddress ?? "unknown";
    if (!live.subscribe(res, ip)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders?.();
    // Prime the stream so clients/proxies see bytes immediately.
    res.write(`data: ${JSON.stringify({ type: "ping", at: new Date().toISOString() })}\n\n`);
  });

  return router;
}
