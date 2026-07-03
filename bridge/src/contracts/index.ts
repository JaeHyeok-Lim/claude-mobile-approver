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

// The hook's redact() emits ONE of these safe partials — structured, value-free, derived from the
// raw tool_input but carrying NO command bodies / file contents / full paths. The bridge renders a
// Korean abstract + safe partial from it. Backward-tolerant: an old/missing/unknown shape just
// falls through to the generic field-name summary.
export type SafeInput =
  // Bash: leading program token + an optional PLAIN subcommand + total token count. No args/flags.
  | { kind: "bash"; prog: string; sub: string | null; argc: number }
  // File tools: basename + a masked path (root + … + last 2 segments). No file contents.
  | { kind: "file"; basename: string; pathMasked: string }
  // Anything else: field NAMES only (the schema, never the values).
  | { kind: "other"; fields: string[]; count: number };

// ---- POST /v1/approvals (hook -> bridge) -----------------------------------
// The hook sends a REDACTED summary only. Full tool_input must NEVER cross this boundary.
export interface CreateApprovalRequest {
  sessionId: string;
  tool: string;
  // Already-redacted, structured safe partial produced by the hook's redact() (see SafeInput).
  // Typed as unknown on the wire: the bridge validates the shape before trusting it.
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
  // The structured safe partial (see SafeInput) when the hook supplied a recognized shape.
  // Optional + already-safe: omitted on legacy/unknown inputs so older clients still render.
  safeInput?: SafeInput;
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
  | { type: "batch"; batch: BatchView }
  | { type: "ping"; at: string };

// ---- Batch 결재 (agent-authored, rich, coverage-granting) --------------------
// The AGENT submits a rich, human-authored batch approval describing planned work. On approve it
// becomes an ACTIVE GRANT that covers subsequent mutating tool calls (matched by cwd + file scope)
// so the PreToolUse hook lets them through SILENTLY (no per-call card). This is the ONLY way work
// is authorized in "batch" gate mode — an uncovered mutating call is denied.
//
// SECURITY: like approvals, this carries NO secrets. The agent writes a FUNCTIONAL summary
// (파일·기능·수정방식·결정·근거); raw command bodies, file contents, and tokens are never included.
// Same terminal-state / expiry-beats-allow discipline as ApprovalStore.
export type GrantStatus = ApprovalStatus; // "pending" | "allow" | "deny" | "expired"

// ---- POST /v1/batches (agent -> bridge) ------------------------------------
export interface CreateBatchRequest {
  // Project path this batch is scoped to. Coverage binds to this cwd (the agent always knows it),
  // so a grant authorizes work only for the originating project.
  cwd: string;
  // Optional session label — used for display + topic routing, and (when both sides set it)
  // tightens coverage to that session. Omit and coverage falls back to cwd-only binding.
  sessionId?: string;
  title: string; // one-line headline shown at the top of the card
  // Rich human one-liners: each describes 파일·기능·수정방식·결정·근거. Rendered verbatim (escaped).
  items: string[];
  files?: string[]; // absolute file paths covered (Edit/Write/MultiEdit/NotebookEdit)
  dirs?: string[]; // directory prefixes covered (a call under one of these is covered)
  bash?: boolean; // whether Bash tool calls are covered by this batch
  maxOps?: number; // max mutating ops this grant authorizes (server clamps to a hard cap)
}

export interface CreateBatchResponse {
  batchId: string;
  status: GrantStatus; // "pending" on success
  expiresAt: string; // pending-decision TTL (ISO-8601 UTC)
}

export interface BatchView {
  batchId: string;
  status: GrantStatus;
  cwd: string;
  sessionId?: string;
  title: string;
  items: string[];
  files: string[];
  dirs: string[];
  bash: boolean;
  maxOps: number;
  remainingOps: number;
  createdAt: string; // ISO-8601 UTC
  // Pending-decision expiry while "pending"; the GRANT expiry once "allow" (agent has this long +
  // remainingOps to execute the batch). ISO-8601 UTC.
  expiresAt: string;
  resolvedAt?: string; // ISO-8601 UTC, set on allow/deny
}

export interface ListBatchesResponse {
  batches: BatchView[];
}

// ---- POST /v1/coverage (hook -> bridge) ------------------------------------
// The PreToolUse hook asks whether a pending mutating call is covered by an ACTIVE grant. When
// covered the bridge ATOMICALLY consumes one op and returns covered:true; the hook then allows the
// call silently. Not covered (or any ambiguity) -> covered:false -> the hook default-denies.
export interface CoverageRequest {
  cwd: string;
  sessionId?: string;
  tool: string;
  path?: string; // file_path / notebook_path for file tools; omitted for Bash
}
export interface CoverageResponse {
  covered: boolean;
  batchId?: string;
  remainingOps?: number;
  reason?: string; // short human reason when not covered
}
