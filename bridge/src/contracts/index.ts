// Wire contracts — the single source of truth shared across hooks <-> bridge <-> app.
//
// Two facts these types encode (see docs/ARCHITECTURE.md + the architect spec):
//  - The hook emits the real Claude Code PreToolUse format; the bridge only deals in the
//    `Decision`/`ApprovalStatus` enums that map cleanly onto it.
//  - The REST responses are a SUPERSET that the app maps trivially to `ApprovalItem`
//    (app/src/components/ApprovalCard.tsx) and `FeedEvent` (app/src/components/EventRow.tsx).
//    Do not invent a divergent field vocabulary.

// "allow"/"deny" = a human (or auto-rule) resolved it.
// "expired"      = TTL lapsed with no resolution -> treated as deny by the hook.
// The hook only ever ACTS on allow vs (deny | expired | anything-else).
// `expired` is a READ-ONLY projection: computed on read when now > expiresAt && status==="pending".
// It is never written by a client.
export type ApprovalStatus = "pending" | "allow" | "deny" | "expired";

// What a resolver (the app) submits.
export type Decision = "allow" | "deny";

// Matches the app FeedEvent.kind vocabulary.
export type EventKind =
  | "SubagentStop"
  | "Notification"
  | "PostToolUse"
  | "Decision"
  | "ApprovalRequest";

export type EventSeverity = "info" | "warn" | "error";

// Closed set of machine error codes for the non-2xx envelope.
export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "already_resolved"
  | "expired"
  | "bad_request"
  | "rate_limited"
  | "internal";

export interface ErrorBody {
  error: ErrorCode;
  message?: string;
}

// ---- POST /v1/approvals (hook -> bridge) -----------------------------------
// The hook sends a REDACTED summary only. Full tool_input must NEVER cross this boundary.
export interface CreateApprovalRequest {
  sessionId: string;
  tool: string;
  // Already-redacted shape map produced by the hook's redact(). Treated as opaque here.
  inputSummary: unknown;
  cwd?: string;
}

export interface CreateApprovalResponse {
  requestId: string;
  status: ApprovalStatus; // "pending" on success
  expiresAt: string; // ISO-8601 UTC
}

// ---- GET /v1/approvals/:id (hook poll) / list (app) ------------------------
// Superset of the app's ApprovalItem. The app maps: summary <- humanSummary,
// sessionLabel <- sessionId, and computes expiresInLabel from expiresAt.
export interface ApprovalView {
  requestId: string;
  tool: string;
  status: ApprovalStatus;
  // REDACTED one-line summary suitable for display. Never the full tool input.
  summary: string;
  cwd?: string;
  sessionId: string;
  createdAt: string; // ISO-8601 UTC
  expiresAt: string; // ISO-8601 UTC
  resolvedAt?: string; // ISO-8601 UTC, set when allow/deny
}

export interface ListApprovalsResponse {
  approvals: ApprovalView[];
}

// ---- POST /v1/approvals/:id/resolve (app -> bridge) ------------------------
export interface ResolveApprovalRequest {
  decision: Decision;
}

export type ResolveApprovalResponse = ApprovalView;

// ---- Events (notify.mjs -> bridge ; app reads) -----------------------------
// Superset of the app's FeedEvent. The app maps: message <- message, timeLabel from createdAt.
export interface CreateEventRequest {
  kind: EventKind;
  // REDACTED one-line summary — never full tool input.
  message: string;
  severity?: EventSeverity;
  // optional agent / session origin label
  source?: string;
}

export interface EventView {
  id: string;
  kind: EventKind;
  message: string;
  severity: EventSeverity;
  source?: string;
  createdAt: string; // ISO-8601 UTC
}

export interface ListEventsResponse {
  events: EventView[];
}

// ---- POST /v1/register (app push-token registration) -----------------------
export interface RegisterDeviceRequest {
  // Expo push token, e.g. "ExponentPushToken[xxxxxxxx]".
  expoPushToken: string;
  // Optional human label for the device.
  label?: string;
}

export interface RegisterDeviceResponse {
  registered: true;
}

// ---- SSE live channel frames (bridge -> app) -------------------------------
// Each SSE `data:` line is one of these JSON envelopes; `event:` field carries the type.
export type LiveFrame =
  | { type: "event"; event: EventView }
  | { type: "approval"; approval: ApprovalView }
  | { type: "ping"; at: string };
