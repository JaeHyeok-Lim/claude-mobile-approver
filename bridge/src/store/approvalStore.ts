// In-memory approval store — the correctness-critical core of the bridge.
//
// State machine (default-deny is a protocol invariant, not an implementation detail):
//
//   create() -> "pending"  (with an absolute expiresAt = now + ttl)
//   resolve("allow")       -> "allow"   (only from "pending", and only before expiry)
//   resolve("deny")        -> "deny"    (only from "pending")
//   read after expiresAt   -> "expired" (READ-ONLY projection; treated as deny by the hook)
//
// Once allow/deny/expired, the request is terminal: resolve() refuses to change it. There is no
// path from any terminal state to "allow", so a late/replayed/forged resolve can never flip an
// expired-or-denied request into an allow. Expiry beats a racing allow: if `now > expiresAt`,
// resolve() is rejected even if status is still stored as "pending".
//
// We never store the full tool input — only the redacted one-line `summary` (see redact.ts).

import { randomUUID } from "node:crypto";
import type { ApprovalStatus, ApprovalView, Decision, SafeInput } from "../contracts/index.js";

interface StoredApproval {
  requestId: string;
  tool: string;
  summary: string; // REDACTED — never raw tool input
  safeInput?: SafeInput; // structured safe partial (already value-free); used by the Telegram card
  cwd?: string;
  sessionId: string;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
  // What the store has been told. The PUBLIC status is derived (see effectiveStatus): a stored
  // "pending" past its expiry reads as "expired".
  resolved?: Decision;
  resolvedAt?: number; // epoch ms
}

export interface CreateInput {
  tool: string;
  summary: string;
  safeInput?: SafeInput;
  cwd?: string;
  sessionId: string;
}

export class ApprovalStore {
  private readonly items = new Map<string, StoredApproval>();
  private readonly ttlMs: number;
  private readonly retainMs: number;

  constructor(opts: { ttlMs: number; retainMs: number }) {
    this.ttlMs = opts.ttlMs;
    this.retainMs = opts.retainMs;
  }

  create(input: CreateInput): ApprovalView {
    const now = Date.now();
    const rec: StoredApproval = {
      requestId: randomUUID(),
      tool: input.tool,
      summary: input.summary,
      safeInput: input.safeInput,
      cwd: input.cwd,
      sessionId: input.sessionId,
      createdAt: now,
      expiresAt: now + this.ttlMs
    };
    this.items.set(rec.requestId, rec);
    return this.toView(rec, now);
  }

  // Returns the current view, or undefined if unknown (a store miss -> the hook default-denies).
  get(requestId: string): ApprovalView | undefined {
    const rec = this.items.get(requestId);
    if (!rec) return undefined;
    return this.toView(rec, Date.now());
  }

  // Number of still-live PENDING requests (stored "pending" and not past expiry). Used by the
  // route to cap creates so a flood of unresolved approvals can't exhaust heap.
  pendingCount(now = Date.now()): number {
    let n = 0;
    for (const rec of this.items.values()) {
      if (!rec.resolved && now < rec.expiresAt) n += 1;
    }
    return n;
  }

  list(): ApprovalView[] {
    const now = Date.now();
    return [...this.items.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => this.toView(r, now));
  }

  // Resolve a pending request. Returns a discriminated result so the route can map it to the
  // right HTTP envelope. CRITICAL: expiry wins over a racing allow, and terminal states are
  // immutable — there is no transition INTO "allow" except from a still-live "pending".
  resolve(
    requestId: string,
    decision: Decision
  ):
    | { ok: true; view: ApprovalView }
    | { ok: false; reason: "not_found" | "expired" | "already_resolved" } {
    const rec = this.items.get(requestId);
    if (!rec) return { ok: false, reason: "not_found" };

    const now = Date.now();

    if (rec.resolved) {
      // Already allow/deny — immutable. A second/forged resolve is rejected (no replay flip).
      return { ok: false, reason: "already_resolved" };
    }
    if (now >= rec.expiresAt) {
      // TTL lapsed before this resolve landed -> default-deny wins. We do NOT honor the allow.
      // Deadline is inclusive: at-or-past expiresAt is expired.
      return { ok: false, reason: "expired" };
    }

    rec.resolved = decision;
    rec.resolvedAt = now;
    return { ok: true, view: this.toView(rec, now) };
  }

  // Drop terminal/expired records that have outlived the retention window. Idempotent; safe to
  // call on an interval. Never touches still-pending-and-live requests.
  sweep(now = Date.now()): void {
    for (const [id, rec] of this.items) {
      const terminalSince = rec.resolvedAt ?? (now > rec.expiresAt ? rec.expiresAt : undefined);
      if (terminalSince !== undefined && now - terminalSince > this.retainMs) {
        this.items.delete(id);
      }
    }
  }

  private effectiveStatus(rec: StoredApproval, now: number): ApprovalStatus {
    if (rec.resolved) return rec.resolved; // "allow" | "deny"
    if (now >= rec.expiresAt) return "expired"; // read-only projection -> hook treats as deny
    return "pending";
  }

  private toView(rec: StoredApproval, now: number): ApprovalView {
    const view: ApprovalView = {
      requestId: rec.requestId,
      tool: rec.tool,
      status: this.effectiveStatus(rec, now),
      summary: rec.summary,
      sessionId: rec.sessionId,
      createdAt: new Date(rec.createdAt).toISOString(),
      expiresAt: new Date(rec.expiresAt).toISOString()
    };
    if (rec.safeInput !== undefined) view.safeInput = rec.safeInput;
    if (rec.cwd !== undefined) view.cwd = rec.cwd;
    if (rec.resolvedAt !== undefined) view.resolvedAt = new Date(rec.resolvedAt).toISOString();
    return view;
  }
}
