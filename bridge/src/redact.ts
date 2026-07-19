// Redaction is a PROTOCOL INVARIANT, not a nicety: full tool input may carry secrets and must
// never be persisted, logged, pushed, or returned. The hook already sends a STRUCTURED safe
// partial (SafeInput) — program + plain subcommand for Bash, basename + masked path for file
// tools, field NAMES otherwise — never raw command bodies / file contents / full paths. The
// bridge derives from it: a short one-line `summary` (legacy), plus the Korean abstract + safe
// partial + masked path for the Telegram card. None of these can surface a raw value.

import type { SafeInput } from "./contracts/index.js";

const MAX_SUMMARY_LEN = 200;

// Build a one-line, value-free summary for the legacy `summary` field (web list / push / event).
// The hook now sends a STRUCTURED SafeInput, so derive a MEANINGFUL Korean abstract from it
// (e.g. "셸 명령 'git status' 실행 …"); only fall back to bare field NAMES for a legacy/unknown
// shape. (Previously this listed the SafeInput WRAPPER's keys -> "Bash · 4 fields (kind, prog, …)".)
export function buildSummary(tool: string, inputSummary: unknown): string {
  const safe = coerceSafeInput(inputSummary);
  if (safe) return clampLine(abstractKo(tool, safe), MAX_SUMMARY_LEN);

  const safeTool = sanitizeToken(tool) || "unknown";
  let fieldNames: string[] = [];
  if (inputSummary && typeof inputSummary === "object" && !Array.isArray(inputSummary)) {
    fieldNames = Object.keys(inputSummary as Record<string, unknown>).map(sanitizeToken);
  }
  const count = fieldNames.length;
  const noun = count === 1 ? "field" : "fields";
  const list = count ? ` (${fieldNames.slice(0, 8).join(", ")})` : "";
  const summary = `${safeTool} · ${count} ${noun}${list}`;
  return summary.length > MAX_SUMMARY_LEN ? summary.slice(0, MAX_SUMMARY_LEN - 1) + "…" : summary;
}

// ---- Safe-partial handling for the Telegram card -----------------------------------------------
// The hook now emits a STRUCTURED safe partial (SafeInput). We validate the wire shape here before
// trusting it, then render a Korean abstract + a one-line safe partial. NONE of these helpers can
// surface a raw value: bash carries only prog + a plain subcommand, file carries only a basename +
// masked path, other carries only field names — exactly what redact() was allowed to send.

// Validate an untrusted wire value into a SafeInput, or undefined if it's legacy/missing/garbage.
// Strings are re-sanitized (the hook is trusted, but this is the trust boundary — belt and braces).
export function coerceSafeInput(v: unknown): SafeInput | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case "bash":
      return coerceBash(o);
    case "file":
      return coerceFile(o);
    case "other":
      return coerceOther(o);
    default:
      return undefined;
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// Safe bare program name: starts with a letter, then word chars / . / - , ≤32. Anything with
// = : / \ quotes $ ( ) or whitespace fails -> it's an env-assignment, path, subshell, or quoted
// value that may carry a secret. Mirrors the hook (belt-and-braces at the trust boundary).
const SAFE_PROG = /^[A-Za-z][\w.-]{0,31}$/;
function coerceBash(o: Record<string, unknown>): SafeInput | undefined {
  if (typeof o.prog !== "string") return undefined;
  const rawProg = sanitizeToken(o.prog);
  const prog = SAFE_PROG.test(rawProg) ? rawProg : "(명령)";
  const sub = typeof o.sub === "string" ? sanitizeToken(o.sub) : "";
  return { kind: "bash", prog, sub: sub || null, argc: num(o.argc, 0) };
}

function coerceFile(o: Record<string, unknown>): SafeInput | undefined {
  if (typeof o.basename !== "string" || typeof o.pathMasked !== "string") return undefined;
  return { kind: "file", basename: sanitizeToken(o.basename), pathMasked: sanitizeToken(o.pathMasked) };
}

function coerceOther(o: Record<string, unknown>): SafeInput {
  // Cap the array before mapping so a hostile/huge fields array can't cause unbounded allocation.
  const fields = Array.isArray(o.fields) ? o.fields.slice(0, 32).map(sanitizeToken) : [];
  return { kind: "other", fields, count: num(o.count, fields.length) };
}

// Korean tool label for the 도구 line. Never throws on an unknown tool.
export function koreanToolLabel(tool: string): string {
  switch (tool) {
    case "Bash":
      return "셸 명령 실행";
    case "Edit":
    case "MultiEdit":
      return "파일 수정";
    case "Write":
      return "파일 생성·덮어쓰기";
    case "Read":
      return "파일 읽기";
    case "NotebookEdit":
      return "노트북 수정";
    case "WebFetch":
    case "WebSearch":
      return "웹 요청";
    case "Glob":
    case "Grep":
      return "파일 검색";
    default:
      return `${sanitizeToken(tool) || "unknown"} 실행`;
  }
}

// Line 1 of 내용: a short Korean description derived from the safe partial.
export function abstractKo(tool: string, safe: SafeInput | undefined): string {
  const label = koreanToolLabel(tool);
  if (safe?.kind === "bash") {
    const cmd = safe.sub ? `${safe.prog} ${safe.sub}` : safe.prog;
    return `셸 명령 '${cmd}' 실행 (총 ${safe.argc}개 토큰)`;
  }
  if (safe?.kind === "file") {
    return `${label}: ${safe.basename}`;
  }
  if (safe?.kind === "other") {
    return `${label} (필드 ${safe.count}개)`;
  }
  return label;
}

// Line 2 of 내용 (optional): a one-line safe partial, ≤ ~60 chars. Returns "" when there's nothing
// safe to add. NEVER includes a raw value beyond the safe tokens the hook already emitted.
export function safePartial(safe: SafeInput | undefined): string {
  if (safe?.kind === "bash") {
    const cmd = safe.sub ? `${safe.prog} ${safe.sub}` : safe.prog;
    return clampLine(`명령: ${cmd} …`, 60);
  }
  if (safe?.kind === "file") {
    return clampLine(`파일: ${safe.basename}`, 60);
  }
  if (safe?.kind === "other" && safe.fields.length) {
    return clampLine(`필드: ${safe.fields.join(", ")}`, 60);
  }
  return "";
}

// Mask a path to root + … + the LAST 2 segments, collapsing the middle. Same rule as the hook's
// maskPath, applied bridge-side to the cwd (which the hook sends whole) so the 경로 line for
// non-file tools is still useful but masked. Handles both \ and /. ≤3 segments -> shown as-is.
export function maskPath(p: string): string {
  const s = String(p ?? "");
  const leadingSlash = /^[\\/]/.test(s);
  const segs = s.split(/[\\/]+/).filter((seg) => seg.length > 0);
  const [root] = segs;
  if (root === undefined) return s;
  const sep = /^[A-Za-z]:$/.test(root) ? "\\" : "/";
  const head = leadingSlash ? sep : "";
  if (segs.length <= 3) return head + segs.join(sep);
  const tail = segs.slice(-2);
  return `${head}${root}${sep}…${sep}${tail.join(sep)}`;
}

// Keep identifiers boring: strip control chars / newlines so nothing can smuggle log-injection
// or hidden payloads through a tool/field name.
function sanitizeToken(v: unknown): string {
  return String(v ?? "")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

// Clamp/clean a client-supplied display string (event messages, device labels) so a single
// line can't break the feed or inject control sequences. Still NOT a place for tool input.
export function clampLine(v: unknown, max = 240): string {
  const s = String(v ?? "")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
