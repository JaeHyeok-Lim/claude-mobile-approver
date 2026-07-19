#!/usr/bin/env node
// Remote approval gate for Claude Code (PreToolUse hook).
// Mirrors the discipline of a Claude Code tracking hook:
// zero-dependency, plain .mjs, never throws past the safe default.
//
// Flow (see docs/ARCHITECTURE.md + docs/batch-approval.md):
//   Mode "off" (default): emit "ask" -> Claude Code's native in-session permission prompt.
//   Mode "batch": risk-tiered gate — SAFE work runs autonomously (no 결재); RISKY work must be
//     covered by an approved batch 결재 (single /v1/coverage check, no long-poll); gate-control
//     writes are denied. Emit a PreToolUse permissionDecision on stdout.
//
// SECURITY: this is an approval gate. A bug that auto-approves is worse than one that blocks.
//   - DEFAULT-DENY on network error, parse failure, or any ambiguity.
//   - Never send the full tool_input (may contain secrets) — only a redacted summary / safe partial.
//
// Config via env (installed in the TARGET project's .claude/settings.json):
//   BRIDGE_URL    base URL of the bridge        (default http://127.0.0.1:4318)
//   BRIDGE_TOKEN  shared bearer token           (REQUIRED for coverage; missing -> risky work denies)
//   APPROVE_HTTP_MS     per-request timeout ms   (default 8000)

import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
// (fileURLToPath is imported once below, near the entry-point guard; ESM hoists it module-wide.)

// Resolve config from env FIRST, then fall back to the bridge's .env (this file is
// <repo>/hooks/approve.mjs, so ../bridge/.env). This makes the gate work even when Claude Code
// does NOT forward the settings.json hook `env` block to the hook process (version-dependent),
// and keeps BRIDGE_TOKEN out of settings.json. Node reading its own sibling config file is fine —
// it is NOT the `powershell -Bypass` secret-grep + HTTP pattern that AV heuristics flag.
function fromEnvFile(key) {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge', '.env');
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i !== -1 && t.slice(0, i).trim() === key) {
        let v = t.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return v;
      }
    }
  } catch { /* no/unreadable .env -> fall through to default/empty */ }
  return '';
}

const BRIDGE_URL = (process.env.BRIDGE_URL || fromEnvFile('BRIDGE_URL') || 'http://127.0.0.1:4318').replace(/\/+$/, '');
const TOKEN = process.env.BRIDGE_TOKEN || fromEnvFile('BRIDGE_TOKEN');
const HTTP_MS = int(process.env.APPROVE_HTTP_MS, 8000);

function int(v, d) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// Gate mode, read from <repo>/bridge/.gate-mode on every call (so `scripts/gate.mjs` toggles take
// effect for the NEXT tool call, even mid-session). Values:
//   "off"   -> emit "ask"; Claude Code uses its NATIVE in-session permission flow (no remote gate).
//             DEFAULT (a fresh install is non-surprising until the user opts into remote gating).
//   "batch" -> risk-tiered coverage: auto-allow SAFE work (autonomy), require an approved batch
//             결재 for RISKY work, deny gate-killswitch writes.
// Missing/unknown file -> "off".
function gateMode() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge', '.gate-mode');
    const v = readFileSync(p, 'utf8').trim().toLowerCase();
    if (v === 'off' || v === 'batch') return v;
  } catch {
    /* no/unreadable file -> default */
  }
  return 'off';
}

// Emit a PreToolUse decision and exit. exit code 0: Claude Code reads stdout JSON. We exit only
// AFTER stdout is flushed (write callback) so the decision isn't truncated on POSIX pipes.
function decide(decision, reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision, // "allow" | "deny" | "ask"
      permissionDecisionReason: reason,
    },
  };
  try {
    process.stdout.write(JSON.stringify(out), () => process.exit(0));
  } catch {
    process.exit(0); // stdout failure is ambiguous; the safe default was already chosen by callers
  }
}

const deny = (reason) => decide('deny', `[agent-mobile-bridge] ${reason}`);
const allow = (reason) => decide('allow', `[agent-mobile-bridge] ${reason}`);
// "ask" hands the decision back to Claude Code's native permission flow (used in gate mode "off").
const defer = (reason) => decide('ask', `[agent-mobile-bridge] ${reason}`);

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

// ---------- Risk policy (batch mode): SAFE = autonomous; else needs an approved 결재 ----------

// Shell metacharacters enabling chaining / redirection / substitution. Their presence makes a Bash
// command RISKY (we can't reason about compound commands) and blocks the submit-batch exemption.
const SHELL_META = /[;&|`$(){}<>\n]|&&|\|\|/;

// Bash "prog"/"prog sub" pairs safe to run autonomously. STRICTLY read-only inspection + LOCAL vcs.
// CRITICAL: interpreters and script-runners (node/python/deno/bun/npm|pnpm|yarn run|test|start,
// npx *, tsc) are NOT here — they execute arbitrary project code and would nullify the gate (a
// child process runs outside all hooks). `find` is excluded too (-delete/-exec destroy without a
// metacharacter). `npm install` excluded (network + postinstall). To run any of these autonomously,
// approve them explicitly per-batch via bashAllow. isSafeBash only inspects prog+sub, so every entry
// here must be harmless REGARDLESS of its arguments.
const SAFE_BASH = new Set([
  'ls', 'dir', 'pwd', 'echo', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg', 'which', 'where', 'env',
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git add', 'git commit', 'git stash', 'git fetch', 'git remote'
]);

function firstTwoTokens(command) {
  const t = String(command).trim().split(/\s+/).filter((x) => x.length > 0);
  return { prog: (t[0] || '').toLowerCase(), sub: (t[1] || '').toLowerCase() };
}

function isSafeBash(command) {
  if (!command || SHELL_META.test(command)) return false;
  const { prog, sub } = firstTwoTokens(command);
  if (!prog) return false;
  return SAFE_BASH.has(prog) || (!!sub && SAFE_BASH.has(`${prog} ${sub}`));
}

// Canonicalize a path (lowercase, forward slashes, resolve ./..) — mirrors the bridge's normPath so
// containment checks agree. Never throws.
function normp(p) {
  const raw = String(p ?? '').replaceAll('\\', '/').toLowerCase();
  const rooted = raw.startsWith('/');
  const out = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const top = out.at(-1);
      if (top !== undefined && top !== '..' && !/^[a-z]:$/.test(top)) out.pop();
      else if (!out.length && !rooted) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return (rooted ? '/' : '') + out.join('/');
}

function baseName(p) {
  const s = normp(p).split('/');
  return s.at(-1) ?? '';
}

function underDir(path, dir) {
  const p = normp(path);
  const d = normp(dir);
  return d.length > 0 && (p === d || p.startsWith(d + '/'));
}

// Secret/sensitive files are NOT auto-editable even inside the project.
function isSensitiveFile(path) {
  const b = baseName(path);
  const n = normp(path);
  return (
    b === '.env' || b.startsWith('.env.') || b === '.gate-mode' ||
    n.includes('/.git/') || /(^|\/)settings(\.local)?\.json$/.test(n)
  );
}

// Repo root — this file is <repo>/hooks/approve.mjs, so its parent is the approver repo.
function repoRoot() {
  return normp(join(dirname(fileURLToPath(import.meta.url)), '..'));
}

// The gate's OWN control plane: kill-switch file, hook scripts, bridge source, installer scripts,
// package manifest, and .claude config. Editing any of these could disable/subvert the gate, so
// they are NEVER auto-allowed or coverable — the human changes them out-of-band (gate off). This
// closes the "session running IN the approver repo edits its own gate logic" hole.
function touchesControlPlane(path) {
  const n = normp(path);
  if (baseName(path) === '.gate-mode') return true;
  const root = repoRoot();
  if (!(n === root || n.startsWith(root + '/'))) return false;
  const rel = n.slice(root.length + 1);
  return (
    rel.startsWith('bridge/') ||
    rel.startsWith('scripts/') ||
    rel.startsWith('hooks/') ||
    rel.startsWith('.claude/') ||
    rel === 'package.json' ||
    rel === 'package-lock.json'
  );
}

function touchesKillswitch(tool, command, path) {
  if (tool === 'Bash') {
    // Bash coverage can't see redirect targets, so any command MENTIONING the mode file / gate.mjs
    // is denied outright (conservative).
    const c = String(command).replaceAll('\\', '/').toLowerCase();
    return c.includes('.gate-mode') || /\bgate\.mjs\b/.test(c);
  }
  return touchesControlPlane(path);
}

// Bootstrap exemption: ONLY the repo's own scripts/submit-batch.mjs, invoked as `node <script> …`
// with the script as the FIRST argument and NO shell metacharacters. The script arg is resolved
// against cwd and must EQUAL the canonical path — so `node evil.js submit-batch.mjs` (arg injection)
// and a planted `x/submit-batch.mjs` are both rejected.
function isSubmitBatchCommand(command, cwd) {
  if (!command || SHELL_META.test(command)) return false;
  const toks = command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/^"|"$/g, ''));
  if (toks.length < 2) return false;
  if (!/(^|[\\/])node(\.exe)?$/i.test(toks[0])) return false;
  const script = toks[1];
  const resolved = normp(isAbsolute(script) ? script : join(cwd || '', script));
  const canonical = normp(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'submit-batch.mjs'));
  return resolved === canonical;
}

function isSafe(tool, command, path, cwd) {
  if (tool === 'Bash') return isSafeBash(command);
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    return !!path && underDir(path, cwd) && !isSensitiveFile(path);
  }
  return false;
}

async function main() {
  // Parse the hook payload from Claude Code.
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return deny('unparsable hook payload');
  }

  // "off" (default) -> hand to Claude Code's native prompt. "batch" -> risk-tiered gate below.
  if (gateMode() === 'off') return defer('gate off — 세션 승인창 사용');
  return gatedDecision(input);
}

// BATCH mode, risk-tiered:
//   1. kill-switch writes (.gate-mode/gate.mjs/hook scripts)  -> DENY (human toggles out-of-band)
//   2. the 결재-submit command itself (strict, no chaining)   -> ALLOW (bootstrap, creates only a
//      pending request that still needs a human tap)
//   3. SAFE work (in-project edits, allowlisted no-meta bash) -> ALLOW (autonomy, no 결재)
//   4. RISKY work                                             -> covered by an active 결재 ? ALLOW : DENY
async function gatedDecision(input) {
  const tool = input.tool_name || 'unknown';
  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const command = typeof ti.command === 'string' ? ti.command : '';
  const path =
    typeof ti.file_path === 'string'
      ? ti.file_path
      : typeof ti.notebook_path === 'string'
        ? ti.notebook_path
        : '';

  if (touchesKillswitch(tool, command, path)) {
    return deny('게이트 제어 파일(.gate-mode/gate.mjs/훅)은 원격 결재로 변경 불가 — 터미널에서 직접');
  }
  if (tool === 'Bash' && isSubmitBatchCommand(command, cwd)) {
    return allow('결재 제출 명령 — 예외 허용');
  }
  if (isSafe(tool, command, path, cwd)) {
    return allow('안전 작업 — 자율 허용');
  }

  // RISKY -> must be covered by an active 결재. Needs the bridge (and a token).
  if (!TOKEN) return deny('BRIDGE_TOKEN not configured');
  const safe = redact(tool, ti);
  const body = {
    cwd,
    sessionId: input.session_id || undefined,
    tool,
    path: path || undefined,
    prog: safe && safe.kind === 'bash' ? safe.prog : undefined,
    sub: safe && safe.kind === 'bash' ? safe.sub : undefined,
  };
  let res;
  try {
    res = await fetchJson('/v1/coverage', { method: 'POST', body: JSON.stringify(body) });
  } catch {
    return deny('bridge unreachable on coverage check');
  }
  if (res.ok && res.body && res.body.covered === true) {
    return allow(`결재 승인 범위 내 (남은 작업 ${res.body.remainingOps ?? '?'})`);
  }
  return deny('승인된 결재 범위 아님(위험 작업) — scripts/submit-batch.mjs 로 결재 요청 필요');
}

// Run the gate only when invoked as the hook entry point — not when imported by a test, which
// asserts the security-critical redact()/maskPath() in isolation without touching stdin/network.
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch(() => deny('unexpected error'));
}

// Exported for unit tests (the risk policy is security-critical). No side effects on import.
export { redact, maskPath, isSafe, isSafeBash, touchesKillswitch, isSubmitBatchCommand, normp };
