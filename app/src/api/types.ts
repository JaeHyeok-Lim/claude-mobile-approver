// Wire shapes the bridge returns. Per the contract spec, the bridge REST
// responses are a SUPERSET of the app's frozen UI shapes (ApprovalItem in
// ApprovalCard.tsx, FeedEvent in EventRow.tsx) — we map down to those in the
// data hooks, we don't re-derive a divergent vocabulary here.
//
// CRITICAL: the bridge only ever sends a REDACTED `summary`/`message`. The full
// tool_input never crosses this boundary, so the app cannot leak it.

import type { ApprovalStatus, EventSeverity } from "../../src/components";

// GET /v1/approvals  -> { approvals: ApprovalDto[] }
// The status "expired" is a read-only projection the bridge computes on read
// (now > expiresAt && pending); clients never write it.
export interface ApprovalDto {
  requestId: string;
  tool: string;
  // REDACTED one-line summary — never the raw tool input.
  summary: string;
  cwd?: string;
  sessionId?: string;
  status: ApprovalStatus;
  // ISO-8601 UTC; the bridge is the sole authority on expiry, the client only
  // renders a countdown from it.
  expiresAt?: string;
}

export interface ApprovalsResponse {
  approvals: ApprovalDto[];
}

// POST /v1/approvals/:requestId/resolve  body { decision } -> ResolveResponse
export type Decision = "allow" | "deny";

export interface ResolveResponse {
  requestId: string;
  status: ApprovalStatus;
}

// GET /v1/events  -> { events: EventDto[] }
export interface EventDto {
  id: string;
  kind: string;
  // REDACTED one-line summary.
  message: string;
  severity?: EventSeverity;
  source?: string;
  // ISO-8601 UTC; the app formats the clock label locally.
  createdAt: string;
}

export interface EventsResponse {
  events: EventDto[];
}

// POST /v1/register  body { expoPushToken, label? } -> RegisterResponse
export interface RegisterResponse {
  registered: true;
}

// Closed set of machine error codes the bridge returns in { error, message? }.
export type BridgeErrorCode =
  | "unauthorized"
  | "not_found"
  | "already_resolved"
  | "expired"
  | "bad_request"
  | "rate_limited"
  | "internal";

export interface BridgeErrorBody {
  error: BridgeErrorCode;
  message?: string;
}
