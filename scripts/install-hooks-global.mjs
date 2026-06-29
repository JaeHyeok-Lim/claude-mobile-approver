#!/usr/bin/env node
// Install the approval + reporting hooks GLOBALLY, into ~/.claude/settings.json.
//
// What this wires up (for EVERY Claude Code session on this machine):
//   PreToolUse  Bash|Edit|Write|MultiEdit|NotebookEdit -> hooks/approve.mjs  (remote approval gate)
//   Notification                                        -> hooks/notify.mjs Notification
//   PostToolUse                                         -> hooks/notify.mjs PostToolUse
//   SubagentStop                                        -> hooks/notify.mjs SubagentStop
//
// The approval gate is fail-CLOSED (default-deny). Once installed it gates Bash/Edit/Write/… in
// ALL sessions — each mutating tool call waits for a Telegram approval. That is a deliberate,
// global change, so this script is SAFE-BY-DEFAULT:
//   - DRY-RUN by default: prints exactly what it WOULD add/change. Writes nothing without --apply.
//   - --apply: backs up settings.json first, merges (preserving existing keys/hooks), re-validates.
//   - Idempotent: matches our entries by the absolute command path, so re-running never duplicates.
//
// Usage:
//   node scripts/install-hooks-global.mjs              # dry-run (default) — shows the diff
//   node scripts/install-hooks-global.mjs --apply              # write (backup suffix = "manual")
//   node scripts/install-hooks-global.mjs --apply --stamp 20260629  # write (backup suffix = arg)
//
// Zero-dependency, node: builtins only — mirrors hooks/*.mjs and scripts/lib/common.mjs.

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, parseDotEnv, BRIDGE_DIR, log } from "./lib/common.mjs";

const APPLY = process.argv.includes("--apply");
// Deterministic backup suffix — NOT Date.now(): take --stamp <s>, else a fixed "manual".
function stampArg() {
  const i = process.argv.indexOf("--stamp");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return "manual";
}

const SETTINGS_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

const NODE = process.execPath;
const APPROVE = join(REPO_ROOT, "hooks", "approve.mjs");
const NOTIFY = join(REPO_ROOT, "hooks", "notify.mjs");

const BRIDGE_URL = "http://127.0.0.1:4318";
// Read the token ONLY to sanity-check it exists — we do NOT write it into settings.json. The hook
// resolves BRIDGE_TOKEN from bridge/.env itself at runtime (Claude Code does not reliably forward
// the hook `env` block, and keeping the secret out of settings.json is better hygiene).
const bridgeToken = (parseDotEnv(join(BRIDGE_DIR, ".env")).BRIDGE_TOKEN || "").trim();

// Commands we manage. quoting the absolute path keeps spaces (e.g. "C:\Users\…") safe.
const cmdApprove = `"${NODE}" "${APPROVE}"`;
const cmdNotify = (kind) => `"${NODE}" "${NOTIFY}" ${kind}`;
// Only a non-secret hint goes into settings.json; the token is read from bridge/.env by the hook.
const hookEnv = { BRIDGE_URL };

// The four hook entries this installer owns. Shape matches Claude Code's settings schema:
//   hooks.<Event> = [ { matcher?, hooks: [ { type:"command", command, env } ] } ]
const MANAGED = [
  { event: "PreToolUse", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", command: cmdApprove },
  { event: "Notification", matcher: undefined, command: cmdNotify("Notification") },
  { event: "PostToolUse", matcher: undefined, command: cmdNotify("PostToolUse") },
  { event: "SubagentStop", matcher: undefined, command: cmdNotify("SubagentStop") }
];

function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return { exists: false, json: {} };
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  try {
    return { exists: true, json: JSON.parse(raw) };
  } catch (err) {
    log("install-hooks", `FATAL: ${SETTINGS_PATH} is not valid JSON (${err.message}). Refusing to touch it.`);
    process.exit(1);
  }
}

// Build the merged settings + a human-readable list of the changes we would make.
// Preserves every existing key and every hook we don't own.
function plan(settings) {
  const next = structuredClone(settings);
  if (!next.hooks || typeof next.hooks !== "object") next.hooks = {};
  const changes = [];

  for (const m of MANAGED) {
    const list = Array.isArray(next.hooks[m.event]) ? next.hooks[m.event] : [];
    next.hooks[m.event] = list;

    // Is one of OUR commands already present for this event? (idempotency)
    const already = list.some(
      (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?.command === m.command)
    );
    if (already) {
      changes.push({ event: m.event, action: "skip (already present)", command: m.command });
      continue;
    }

    const entry = {
      ...(m.matcher ? { matcher: m.matcher } : {}),
      hooks: [{ type: "command", command: m.command, env: { ...hookEnv } }]
    };
    list.push(entry);
    changes.push({ event: m.event, action: "add", matcher: m.matcher, command: m.command });
  }

  return { next, changes };
}

function tokenNote() {
  if (!bridgeToken) {
    return "WARNING: no BRIDGE_TOKEN found in bridge/.env — the hook will default-DENY every call. Set it before --apply.";
  }
  return `BRIDGE_TOKEN present in bridge/.env (len ${bridgeToken.length}) — the hook reads it from there at runtime (NOT stored in settings.json).`;
}

function printPlan(changes) {
  log("install-hooks", `target: ${SETTINGS_PATH}`);
  log("install-hooks", `BRIDGE_URL=${BRIDGE_URL}`);
  log("install-hooks", tokenNote());
  log("install-hooks", "--- planned settings.json hook entries ---");
  for (const c of changes) {
    if (c.action.startsWith("skip")) {
      log("install-hooks", `  [${c.event}] ${c.action}`);
    } else {
      const matcher = c.matcher ? `matcher "${c.matcher}" ` : "(no matcher) ";
      log("install-hooks", `  [${c.event}] ADD ${matcher}-> ${c.command}`);
      log("install-hooks", `            env: BRIDGE_URL (BRIDGE_TOKEN resolved from bridge/.env at runtime)`);
    }
  }
  log("install-hooks", "------------------------------------------");
}

function main() {
  if (!existsSync(APPROVE) || !existsSync(NOTIFY)) {
    log("install-hooks", `FATAL: hook scripts not found under ${join(REPO_ROOT, "hooks")}.`);
    process.exit(1);
  }

  const { exists, json } = readSettings();
  const { next, changes } = plan(json);
  printPlan(changes);

  if (!APPLY) {
    log("install-hooks", "DRY-RUN (no --apply): nothing was written.");
    log("install-hooks", "Re-run with --apply to back up and merge. To revert: scripts/uninstall-hooks-global.mjs --apply");
    return;
  }

  const nothingToDo = changes.every((c) => c.action.startsWith("skip"));
  if (nothingToDo) {
    log("install-hooks", "all entries already present — nothing to write.");
    return;
  }

  // --apply: back up first (deterministic suffix), then write, then re-validate.
  mkdirSync(SETTINGS_DIR, { recursive: true });
  if (exists) {
    const bak = `${SETTINGS_PATH}.bak-${stampArg()}`;
    copyFileSync(SETTINGS_PATH, bak);
    log("install-hooks", `backed up existing settings -> ${bak}`);
  }

  const serialized = JSON.stringify(next, null, 2);
  // Validate before persisting — a corrupt settings.json would break ALL sessions.
  JSON.parse(serialized);
  writeFileSync(SETTINGS_PATH, serialized + "\n", "utf8");
  // Read back and re-parse to confirm the on-disk file is valid JSON.
  JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  log("install-hooks", `wrote ${SETTINGS_PATH} (validated).`);

  log("install-hooks", "");
  log("install-hooks", "WARNING: this gates Bash/Edit/Write/MultiEdit/NotebookEdit in ALL Claude Code");
  log("install-hooks", "         sessions (including ones in THIS folder) — each will require a Telegram");
  log("install-hooks", "         approval before it runs. The bridge must be up (scripts/run-bridge.mjs),");
  log("install-hooks", "         or every mutating call default-denies.");
  log("install-hooks", "         Revert anytime: node scripts/uninstall-hooks-global.mjs --apply");
}

main();
