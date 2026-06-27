#!/usr/bin/env node
// Remote approval gate for Claude Code (PreToolUse hook).
// Mirrors the discipline of a Claude Code tracking hook:
// zero-dependency, plain .mjs, never throws past the safe default.
//
// Flow (see docs/ARCHITECTURE.md):
//   1. POST a REDACTED summary of the pending tool call to the bridge -> get a requestId.
//   2. Bounded long-poll the bridge for the human/auto decision.
//   3. Emit a PreToolUse permissionDecision on stdout: "allow" only on an explicit allow.
//
// SECURITY: this is an approval gate. A bug that auto-approves is worse than one that blocks.
//   - DEFAULT-DENY on timeout, network error, parse failure, or any ambiguous status.
//   - Never send the full tool_input (may contain secrets) — only a redacted summary.
//   - Never hang forever — the poll is bounded by APPROVE_TOTAL_MS.
//
// Config via env (installed in the TARGET project's .claude/settings.json):
//   BRIDGE_URL    base URL of the bridge        (default http://127.0.0.1:4318)
//   BRIDGE_TOKEN  shared bearer token           (REQUIRED; missing -> default-deny)
//   APPROVE_TOTAL_MS    overall budget in ms     (default 120000)
//   APPROVE_POLL_MS     poll interval in ms      (default 1500)
//   APPROVE_HTTP_MS     per-request timeout ms   (default 8000)

import { readFileSync } from 'node:fs';

const BRIDGE_URL = (process.env.BRIDGE_URL || 'http://127.0.0.1:4318').replace(/\/+$/, '');
const TOKEN = process.env.BRIDGE_TOKEN || '';
const TOTAL_MS = int(process.env.APPROVE_TOTAL_MS, 120000);
const POLL_MS = int(process.env.APPROVE_POLL_MS, 1500);
const HTTP_MS = int(process.env.APPROVE_HTTP_MS, 8000);

function int(v, d) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// Emit a PreToolUse decision and exit. exit code 0: Claude Code reads stdout JSON.
function decide(decision, reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision, // "allow" | "deny"
      permissionDecisionReason: reason,
    },
  };
  try {
    process.stdout.write(JSON.stringify(out));
  } catch {
    /* stdout failure is itself ambiguous; we already chose the safe default below */
  }
  process.exit(0);
}

const deny = (reason) => decide('deny', `[agent-mobile-bridge] ${reason}`);
const allow = (reason) => decide('allow', `[agent-mobile-bridge] ${reason}`);

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Build a redacted summary of the tool input. We send shape/size, never raw values.
function redact(input) {
  if (input == null || typeof input !== 'object') return { kind: typeof input };
  const summary = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') {
      summary[k] = { type: 'string', len: v.length };
    } else if (Array.isArray(v)) {
      summary[k] = { type: 'array', len: v.length };
    } else if (v && typeof v === 'object') {
      summary[k] = { type: 'object', keys: Object.keys(v).length };
    } else {
      summary[k] = { type: typeof v };
    }
  }
  return summary;
}

async function fetchJson(path, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_MS);
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        ...opts?.headers,
      },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null; // non-JSON -> treated as ambiguous by callers
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Parse the hook payload from Claude Code.
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return deny('unparsable hook payload');
  }

  // No token configured -> we cannot authenticate the gate -> default-deny.
  if (!TOKEN) return deny('BRIDGE_TOKEN not configured');

  const payload = {
    sessionId: input.session_id || 'local',
    tool: input.tool_name || 'unknown',
    inputSummary: redact(input.tool_input),
    cwd: input.cwd || process.cwd(),
  };

  // 1. Create the pending approval.
  let requestId;
  try {
    const created = await fetchJson('/v1/approvals', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!created.ok || !created.body || typeof created.body.requestId !== 'string') {
      return deny(`bridge rejected approval request (status ${created.status})`);
    }
    requestId = created.body.requestId;
  } catch {
    return deny('bridge unreachable on create');
  }

  // 2. Bounded long-poll for the decision.
  const deadline = Date.now() + TOTAL_MS;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetchJson(`/v1/approvals/${encodeURIComponent(requestId)}`, { method: 'GET' });
    } catch {
      await sleep(POLL_MS);
      continue; // transient error -> keep polling until the deadline, then default-deny
    }
    const status = res.ok && res.body ? res.body.status : null;
    if (status === 'allow') return allow(`approved remotely (${requestId})`);
    if (status === 'deny') return deny(`denied remotely (${requestId})`);
    if (status === 'expired') return deny(`approval expired (${requestId})`);
    // "pending" or anything ambiguous -> keep waiting.
    await sleep(POLL_MS);
  }

  // 3. Budget exhausted with no explicit allow -> DEFAULT-DENY.
  return deny(`no decision within ${TOTAL_MS}ms (${requestId})`);
}

main().catch(() => deny('unexpected error'));
