// Redaction is a PROTOCOL INVARIANT, not a nicety: full tool input may carry secrets and must
// never be persisted, logged, pushed, or returned. The hook already sends a shape-only
// `inputSummary` (types/lengths, a tiny preview), never raw values. The bridge takes that one
// step further: it derives a SHORT, human-readable one-line `summary` from the tool name plus
// the field NAMES of the summary — never the values/previews. That string is the only thing
// stored/returned/pushed.

const MAX_SUMMARY_LEN = 200;

// Build a one-line, value-free summary like: "Bash · 1 field (command)" or
// "Edit · 3 fields (file_path, old_string, new_string)".
export function buildSummary(tool: string, inputSummary: unknown): string {
  const safeTool = sanitizeToken(tool) || "unknown";
  let fieldNames: string[] = [];
  if (inputSummary && typeof inputSummary === "object" && !Array.isArray(inputSummary)) {
    // Field NAMES only. Tool-input keys are part of the schema (e.g. "command", "file_path"),
    // not the secret — the secret lives in the values, which we deliberately drop here.
    fieldNames = Object.keys(inputSummary as Record<string, unknown>).map(sanitizeToken);
  }
  const count = fieldNames.length;
  const noun = count === 1 ? "field" : "fields";
  const list = count ? ` (${fieldNames.slice(0, 8).join(", ")})` : "";
  const summary = `${safeTool} · ${count} ${noun}${list}`;
  return summary.length > MAX_SUMMARY_LEN ? summary.slice(0, MAX_SUMMARY_LEN - 1) + "…" : summary;
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
