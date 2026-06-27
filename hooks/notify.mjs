#!/usr/bin/env node
// Fire-and-forget event reporter for Claude Code (SubagentStop / Notification / PostToolUse).
// Mirrors a Claude Code tracking hook: zero-dependency, plain .mjs, NEVER blocks.
// This is NOT an approval gate — it only reports. It always exits 0 and emits no decision.
//
// Usage in a target project's .claude/settings.json, passing the event kind as argv[2]:
//   node hooks/notify.mjs SubagentStop
//   node hooks/notify.mjs Notification
//   node hooks/notify.mjs PostToolUse
//
// Config via env:
//   BRIDGE_URL    base URL of the bridge   (default http://127.0.0.1:4318)
//   BRIDGE_TOKEN  shared bearer token      (REQUIRED to send; missing -> silently no-op, exit 0)
//   NOTIFY_HTTP_MS  per-request timeout ms (default 4000)
//
// SECURITY: never send the full tool_input (may contain secrets) — only a redacted summary.

import { readFileSync } from 'node:fs';

const BRIDGE_URL = (process.env.BRIDGE_URL || 'http://127.0.0.1:4318').replace(/\/+$/, '');
const TOKEN = process.env.BRIDGE_TOKEN || '';
const HTTP_MS = (() => {
  const n = Number.parseInt(process.env.NOTIFY_HTTP_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 4000;
})();

const kind = process.argv[2] || 'Notification';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Build the REQUIRED, non-empty report message. Prefer Claude Code's own
// top-level `message` (Notification carries one); otherwise derive a safe label
// from the kind/tool. Never includes raw tool input (may contain secrets).
function buildMessage(kind, input) {
  if (typeof input.message === 'string' && input.message.trim()) {
    return input.message.slice(0, 280);
  }
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (kind === 'SubagentStop') return 'subagent finished';
  if (kind === 'PostToolUse') return tool ? `${tool} finished` : 'tool finished';
  return tool ? `${kind}: ${tool}` : kind;
}

async function main() {
  // No token -> we cannot authenticate; do nothing. (A reporting hook must never block.)
  if (!TOKEN) return;

  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = {};
  }

  // The bridge /v1/events route reads only { kind, message, severity, source }.
  // `message` is REQUIRED and must be a non-empty string, so derive a fallback
  // when Claude Code's payload carries no top-level message (e.g. SubagentStop,
  // PostToolUse). `source` is the session/agent origin label.
  const message = buildMessage(kind, input);
  const event = {
    kind, // SubagentStop | Notification | PostToolUse
    message,
    source: input.session_id || 'local',
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_MS);
  try {
    await fetch(`${BRIDGE_URL}/v1/events`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(event),
    });
  } catch {
    /* fire-and-forget: a failed report must never block the agent */
  } finally {
    clearTimeout(timer);
  }
}

// Whatever happens, exit 0. This hook reports; it never gates.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
