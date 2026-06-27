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
  CreateApprovalRequest,
  CreateApprovalResponse,
  CreateEventRequest,
  Decision,
  EventKind,
  EventSeverity,
  RegisterDeviceRequest,
  ResolveApprovalRequest
} from "./contracts/index.js";
import type { ApprovalStore } from "./store/approvalStore.js";
import type { EventStore } from "./store/eventStore.js";
import type { DeviceStore } from "./store/deviceStore.js";
import type { ExpoPush } from "./push/expoPush.js";
import type { LiveHub } from "./live/liveHub.js";
import { config } from "./config.js";
import { buildSummary, clampLine } from "./redact.js";

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
  events: EventStore;
  devices: DeviceStore;
  push: ExpoPush;
  live: LiveHub;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: "bad_request", message });
}

export function buildRouter(deps: Deps): Router {
  const router = Router();
  const { approvals, events, devices, push, live } = deps;

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
    const view = approvals.create({
      tool: clampLine(body.tool, 60),
      summary,
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
    // Feed + live: record the decision (redacted).
    const ev = events.append({
      kind: "Decision",
      message: `${view.tool} ${decision === "allow" ? "승인됨" : "거부됨"}: ${view.summary}`,
      severity: decision === "allow" ? "info" : "warn",
      source: view.sessionId
    });
    live.broadcast({ type: "event", event: ev });
    live.broadcast({ type: "approval", approval: view });
    res.json(view);
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
