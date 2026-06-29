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
//   APPROVE_TOTAL_MS    overall budget in ms     (default 600000 = 10 min, matches bridge TTL)
//   APPROVE_POLL_MS     poll interval in ms      (default 1500)
//   APPROVE_HTTP_MS     per-request timeout ms   (default 8000)

import { readFileSync } from 'node:fs';

const BRIDGE_URL = (process.env.BRIDGE_URL || 'http://127.0.0.1:4318').replace(/\/+$/, '');
const TOKEN = process.env.BRIDGE_TOKEN || '';
const TOTAL_MS = int(process.env.APPROVE_TOTAL_MS, 600000);
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

// Mask a filesystem path to root + … + the LAST 2 segments, collapsing the middle. Handles both
// \ and / separators. ≤3 segments -> shown as-is. NEVER reveals the full middle of the path.
// Zero-dep, never throws (caller's redact() also has a catch-all fallback).
function maskPath(p) {
  const s = String(p ?? '');
  // Split on either separator; remember whether it started at filesystem root (/...).
  const leadingSlash = /^[\\/]/.test(s);
  const segs = s.split(/[\\/]+/).filter((seg) => seg.length > 0);
  if (segs.length === 0) return s;
  // Pick the separator we'll render with: Windows drive paths -> "\", else "/".
  const sep = /^[A-Za-z]:$/.test(segs[0]) ? '\\' : '/';
  const head = leadingSlash ? sep : '';
  // ≤3 segments: short enough to show whole.
  if (segs.length <= 3) return head + segs.join(sep);
  const root = segs[0];
  const tail = segs.slice(-2);
  return `${head}${root}${sep}…${sep}${tail.join(sep)}`;
}

const basenameOf = (p) => {
  const segs = String(p ?? '').split(/[\\/]+/).filter((seg) => seg.length > 0);
  return segs.at(-1) ?? '';
};

// SECURITY: this is the trust boundary. The hook holds the RAW tool_input (which may carry
// secrets in command args, flag values, or file contents). We emit ONLY safe partials —
// program + plain subcommand for Bash, basenames + masked paths for file tools, field NAMES
// otherwise — NEVER raw command bodies, flag values, or file contents.
//
// Shapes emitted (all consumed by the bridge's renderer; backward-tolerant):
//   { kind:"bash",  prog, sub|null, argc }
//   { kind:"file",  basename, pathMasked }
//   { kind:"other", fields:[...names], count }
function redact(tool, input) {
  try {
    if (input == null || typeof input !== 'object') {
      return { kind: 'other', fields: [], count: 0 };
    }

    if (tool === 'Bash' && typeof input.command === 'string') {
      // Token #1 = the program. Token #2 = a plain subcommand ONLY (no =,:,/,\,quotes, ≤16,
      // not a flag). Everything after — args, flags, values — is DROPPED (may hold secrets).
      const tokens = input.command.trim().split(/\s+/).filter((t) => t.length > 0);
      // SECURITY: token #1 is attacker-controlled free text — it can be an env assignment
      // (`SECRET=… cmd`), an absolute path (`/home/u/.private/tool`), a subshell (`$(…)`), or a
      // quoted value. Emit it ONLY if it's a plausible bare program name; otherwise it may carry
      // a secret/path -> redact to a placeholder. (Same discipline as `sub`, slightly longer.)
      const SAFE_PROG = /^[A-Za-z][\w.-]{0,31}$/;
      const rawProg = tokens[0] ?? '';
      const prog = SAFE_PROG.test(rawProg) ? rawProg : '(명령)';
      const second = tokens[1];
      const sub = second && /^[A-Za-z][\w.-]{0,15}$/.test(second) ? second : null;
      return { kind: 'bash', prog, sub, argc: tokens.length };
    }

    if (
      (tool === 'Edit' ||
        tool === 'MultiEdit' ||
        tool === 'Write' ||
        tool === 'Read' ||
        tool === 'NotebookEdit') &&
      (typeof input.file_path === 'string' || typeof input.notebook_path === 'string')
    ) {
      // ONLY the basename + masked path. The content (old_string/new_string/content) is DROPPED.
      const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
      return { kind: 'file', basename: basenameOf(path), pathMasked: maskPath(path) };
    }

    // Other tools: field NAMES only (the schema, not the secret values).
    const fields = Object.keys(input);
    return { kind: 'other', fields, count: fields.length };
  } catch {
    // Anything weird -> safest possible fallback. Never throws past here.
    return { kind: 'other', fields: [], count: 0 };
  }
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
    inputSummary: redact(input.tool_name, input.tool_input),
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

// Run the gate only when invoked as the hook entry point — not when imported by a test, which
// asserts the security-critical redact()/maskPath() in isolation without touching stdin/network.
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch(() => deny('unexpected error'));
}

export { redact, maskPath };
