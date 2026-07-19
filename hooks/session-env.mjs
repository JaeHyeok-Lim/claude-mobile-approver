#!/usr/bin/env node
// SessionStart hook. Exposes the current Claude Code session id to later Bash tool calls as
// CLAUDE_SESSION_ID (via Claude Code's documented CLAUDE_ENV_FILE mechanism), so
// scripts/submit-batch.mjs can bind a batch 결재 to the SAME session id the PreToolUse gate
// (approve.mjs) reports on /v1/coverage. Without this, session-scoped coverage can't match.
//
// Zero-dependency, plain .mjs, best-effort: never blocks or fails session start; always exit 0.
// NOTE: submit-batch also accepts an explicit --session as a fallback, and errors loudly if neither
// is available — so a missing/renamed env-file mechanism degrades to a clear error, not a mis-bind.

import { readFileSync, appendFileSync } from 'node:fs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

try {
  const input = JSON.parse(readStdin() || '{}');
  const sid = typeof input.session_id === 'string' ? input.session_id : '';
  const envFile = process.env.CLAUDE_ENV_FILE;
  // Only write a well-formed session id (UUID-ish) so nothing can be injected into the env file.
  if (envFile && /^[0-9a-fA-F-]{8,64}$/.test(sid)) {
    appendFileSync(envFile, `CLAUDE_SESSION_ID=${sid}\n`, 'utf8');
  }
} catch {
  /* best-effort — a failure here must never block session start */
}
process.exit(0);
