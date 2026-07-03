// In-memory grant store — batch 결재 + coverage. Sibling to ApprovalStore; same security discipline.
//
// A "batch" is an agent-authored, rich approval describing planned work. Lifecycle mirrors an
// approval EXACTLY (default-deny is a protocol invariant):
//
//   create() -> "pending"  (expiresAt = now + ttlMs, the decision window)
//   resolve("allow")       -> "allow"   (only from live "pending"; also arms the GRANT window:
//                                        grantExpiresAt = now + grantTtlMs, remainingOps = maxOps)
//   resolve("deny")        -> "deny"    (only from live "pending")
//   read after expiresAt   -> "expired" (READ-ONLY projection; never authorizes anything)
//
// Once allow/deny/expired the batch is terminal — resolve() refuses to change it, so a late/forged
// resolve can never flip it to allow. Expiry beats a racing allow.
//
// cover() is the security-critical query the PreToolUse hook makes on every mutating call. It
// authorizes a call ONLY when an ACTIVE grant (allow + within grantExpiresAt + remainingOps>0)
// scoped to the same cwd (and session, when both sides name one) covers the call's target. It is
// atomic: a covered call CONSUMES one op, so a bounded grant can't authorize unbounded work.
//
// We store only the agent's FUNCTIONAL summary (title/items) — never raw tool input.

import { randomUUID } from "node:crypto";
import type { BatchView, Decision, GrantStatus } from "../contracts/index.js";

// Normalize a path/cwd for comparison: backslashes -> forward slashes, lowercase (Windows-primary,
// case-insensitive), and RESOLVE "." / ".." segments so a traversal like ".../src/../secret" can't
// textually satisfy a "/src" dir-prefix while actually escaping it. Never throws.
export function normPath(p: string): string {
  const raw = String(p ?? "").replaceAll("\\", "/").toLowerCase();
  const rooted = raw.startsWith("/");
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Pop a real parent; never pop past a drive root (e.g. "c:"). A leading ".." with no parent
      // to consume is kept so such a path can't accidentally collapse to match a real prefix.
      const top = out.at(-1);
      if (top !== undefined && top !== ".." && !/^[a-z]:$/.test(top)) out.pop();
      else if (out.length === 0 && !rooted) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (rooted ? "/" : "") + out.join("/");
}

// Tools whose target is a file path (coverage is by path/dir scope). Bash is handled separately.
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Read"]);

interface StoredGrant {
  batchId: string;
  cwd: string; // normalized
  sessionId: string; // "" if none
  title: string;
  items: string[];
  files: string[]; // normalized absolute paths
  dirs: string[]; // normalized directory prefixes
  bash: boolean;
  maxOps: number;
  remainingOps: number;
  createdAt: number;
  expiresAt: number; // pending-decision expiry
  resolved?: Decision;
  resolvedAt?: number;
  grantExpiresAt?: number; // set on allow: now + grantTtlMs (the execution window)
}

export interface CreateGrantInput {
  cwd: string;
  sessionId?: string;
  title: string;
  items: string[];
  files: string[];
  dirs: string[];
  bash: boolean;
  maxOps: number;
}

export interface CoverageQuery {
  cwd: string;
  sessionId?: string;
  tool: string;
  path?: string;
}

export type CoverageResult = {
  covered: boolean;
  batchId?: string;
  remainingOps?: number;
  reason?: string;
};

export class GrantStore {
  private readonly items = new Map<string, StoredGrant>();
  private readonly ttlMs: number;
  private readonly retainMs: number;
  private readonly grantTtlMs: number;

  constructor(opts: { ttlMs: number; retainMs: number; grantTtlMs: number }) {
    this.ttlMs = opts.ttlMs;
    this.retainMs = opts.retainMs;
    this.grantTtlMs = opts.grantTtlMs;
  }

  create(input: CreateGrantInput): BatchView {
    const now = Date.now();
    const rec: StoredGrant = {
      batchId: randomUUID(),
      cwd: normPath(input.cwd),
      sessionId: input.sessionId ?? "",
      title: input.title,
      items: input.items,
      files: input.files.map(normPath).filter((f) => f.length > 0),
      dirs: input.dirs.map(normPath).filter((d) => d.length > 0),
      bash: input.bash,
      maxOps: input.maxOps,
      remainingOps: input.maxOps,
      createdAt: now,
      expiresAt: now + this.ttlMs
    };
    this.items.set(rec.batchId, rec);
    return this.toView(rec, now);
  }

  get(batchId: string): BatchView | undefined {
    const rec = this.items.get(batchId);
    if (!rec) return undefined;
    return this.toView(rec, Date.now());
  }

  list(): BatchView[] {
    const now = Date.now();
    return [...this.items.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => this.toView(r, now));
  }

  // Still-live PENDING batches (awaiting a decision). Used to cap creates (DoS).
  pendingCount(now = Date.now()): number {
    let n = 0;
    for (const rec of this.items.values()) {
      if (!rec.resolved && now < rec.expiresAt) n += 1;
    }
    return n;
  }

  // Resolve a pending batch. Same discipline as ApprovalStore.resolve: terminal states are
  // immutable and expiry beats a racing allow. On allow, ARM the grant window.
  resolve(
    batchId: string,
    decision: Decision
  ):
    | { ok: true; view: BatchView }
    | { ok: false; reason: "not_found" | "expired" | "already_resolved" } {
    const rec = this.items.get(batchId);
    if (!rec) return { ok: false, reason: "not_found" };

    const now = Date.now();
    if (rec.resolved) return { ok: false, reason: "already_resolved" };
    if (now >= rec.expiresAt) return { ok: false, reason: "expired" };

    rec.resolved = decision;
    rec.resolvedAt = now;
    if (decision === "allow") {
      rec.grantExpiresAt = now + this.grantTtlMs;
    }
    return { ok: true, view: this.toView(rec, now) };
  }

  // SECURITY-CRITICAL. Is this mutating call covered by an ACTIVE grant? If so, atomically consume
  // one op and return covered:true. Any miss/ambiguity -> covered:false (the hook default-denies).
  cover(q: CoverageQuery): CoverageResult {
    const now = Date.now();
    const qCwd = normPath(q.cwd);
    const qPath = q.path !== undefined ? normPath(q.path) : undefined;
    const isBash = q.tool === "Bash";
    const isFileTool = FILE_TOOLS.has(q.tool);

    // Unknown/unsupported tool shape -> never covered (fail closed).
    if (!isBash && !isFileTool) {
      return { covered: false, reason: "unsupported tool for coverage" };
    }
    // A file tool with no resolvable path can't be scope-checked -> fail closed.
    if (isFileTool && !qPath) {
      return { covered: false, reason: "no path to match against grant scope" };
    }

    for (const rec of this.items.values()) {
      // Must be an ACTIVE grant: allowed, within the grant window, ops left.
      if (rec.resolved !== "allow") continue;
      if (rec.grantExpiresAt === undefined || now >= rec.grantExpiresAt) continue;
      if (rec.remainingOps <= 0) continue;

      // Binding: same project cwd always required. If BOTH sides name a session, they must match;
      // a grant with no session binds by cwd alone (broader, but never crosses projects).
      if (rec.cwd !== qCwd) continue;
      if (rec.sessionId !== "" && q.sessionId !== undefined && rec.sessionId !== q.sessionId) {
        continue;
      }

      // Scope: Bash -> the batch must allow bash. File tool -> path must be an exact listed file
      // or sit under a listed dir prefix.
      let inScope = false;
      if (isBash) {
        inScope = rec.bash === true;
      } else if (qPath) {
        inScope =
          rec.files.includes(qPath) ||
          rec.dirs.some((d) => qPath === d || qPath.startsWith(d + "/"));
      }
      if (!inScope) continue;

      // Covered — consume one op.
      rec.remainingOps -= 1;
      return { covered: true, batchId: rec.batchId, remainingOps: rec.remainingOps };
    }

    return { covered: false, reason: "no active 결재 covers this call" };
  }

  // Drop terminal/expired batches past the retention window. Never touches live-pending or grants
  // still inside their execution window.
  sweep(now = Date.now()): void {
    for (const [id, rec] of this.items) {
      // A grant is "done" once denied, or its grant window closed, or a pending one expired.
      let terminalSince: number | undefined;
      if (rec.resolved === "deny") terminalSince = rec.resolvedAt;
      else if (rec.resolved === "allow") {
        terminalSince =
          rec.grantExpiresAt !== undefined && now >= rec.grantExpiresAt ? rec.grantExpiresAt : undefined;
      } else if (now > rec.expiresAt) terminalSince = rec.expiresAt;

      if (terminalSince !== undefined && now - terminalSince > this.retainMs) {
        this.items.delete(id);
      }
    }
  }

  // Public status: "allow" while the grant window is open, else its stored/derived state. A pending
  // batch past its decision window reads "expired". An allowed grant whose execution window closed
  // also reads "expired" (it no longer authorizes anything).
  private effectiveStatus(rec: StoredGrant, now: number): GrantStatus {
    if (rec.resolved === "deny") return "deny";
    if (rec.resolved === "allow") {
      if (rec.grantExpiresAt !== undefined && now >= rec.grantExpiresAt) return "expired";
      return "allow";
    }
    if (now >= rec.expiresAt) return "expired";
    return "pending";
  }

  private toView(rec: StoredGrant, now: number): BatchView {
    const active = rec.resolved === "allow" && rec.grantExpiresAt !== undefined;
    const view: BatchView = {
      batchId: rec.batchId,
      status: this.effectiveStatus(rec, now),
      cwd: rec.cwd,
      title: rec.title,
      items: rec.items,
      files: rec.files,
      dirs: rec.dirs,
      bash: rec.bash,
      maxOps: rec.maxOps,
      remainingOps: rec.remainingOps,
      createdAt: new Date(rec.createdAt).toISOString(),
      // While active, expose the grant (execution) window; otherwise the pending-decision window.
      expiresAt: new Date(active ? rec.grantExpiresAt! : rec.expiresAt).toISOString()
    };
    if (rec.sessionId !== "") view.sessionId = rec.sessionId;
    if (rec.resolvedAt !== undefined) view.resolvedAt = new Date(rec.resolvedAt).toISOString();
    return view;
  }
}
