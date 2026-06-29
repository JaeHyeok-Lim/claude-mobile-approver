#!/usr/bin/env node
// Remove the global approval + reporting hooks from ~/.claude/settings.json.
//
// Removes ONLY the entries this repo installed (matched by the absolute hook-file paths
// hooks/approve.mjs and hooks/notify.mjs). Every other hook and key is left untouched.
// After removal, Claude Code sessions stop gating mutating tools and stop reporting events.
//
// SAFE-BY-DEFAULT (same posture as install-hooks-global.mjs):
//   - DRY-RUN by default: prints what it WOULD remove. Writes nothing without --apply.
//   - --apply: backs up settings.json first, prunes our entries, re-validates the result.
//   - Idempotent: removing when nothing is ours is a no-op.
//
// Usage:
//   node scripts/uninstall-hooks-global.mjs                 # dry-run (default)
//   node scripts/uninstall-hooks-global.mjs --apply                 # write (suffix = "manual")
//   node scripts/uninstall-hooks-global.mjs --apply --stamp 20260629
//
// Zero-dependency, node: builtins only.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, log } from "./lib/common.mjs";

const APPLY = process.argv.includes("--apply");
function stampArg() {
  const i = process.argv.indexOf("--stamp");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return "manual";
}

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const APPROVE = join(REPO_ROOT, "hooks", "approve.mjs");
const NOTIFY = join(REPO_ROOT, "hooks", "notify.mjs");

// Same identity rule as the installer: ours iff the command invokes one of our hook files.
function isOurCommand(cmd) {
  return typeof cmd === "string" && (cmd.includes(APPROVE) || cmd.includes(NOTIFY));
}

function readSettings() {
  if (!existsSync(SETTINGS_PATH)) {
    log("uninstall-hooks", `no settings file at ${SETTINGS_PATH} — nothing to do.`);
    process.exit(0);
  }
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    log("uninstall-hooks", `FATAL: ${SETTINGS_PATH} is not valid JSON (${err.message}). Refusing to touch it.`);
    process.exit(1);
  }
}

// Prune our hooks from every event. Returns { next, removed[] } and drops now-empty arrays.
function plan(settings) {
  const next = structuredClone(settings);
  const removed = [];
  if (!next.hooks || typeof next.hooks !== "object") return { next, removed };

  for (const event of Object.keys(next.hooks)) {
    const list = next.hooks[event];
    if (!Array.isArray(list)) continue;

    const kept = [];
    for (const entry of list) {
      if (!Array.isArray(entry?.hooks)) {
        kept.push(entry);
        continue;
      }
      const keptInner = entry.hooks.filter((h) => {
        if (isOurCommand(h?.command)) {
          removed.push({ event, command: h.command });
          return false;
        }
        return true;
      });
      // Drop an entry entirely if it had only our command(s); otherwise keep the trimmed entry.
      if (keptInner.length > 0) kept.push({ ...entry, hooks: keptInner });
    }

    if (kept.length > 0) next.hooks[event] = kept;
    else delete next.hooks[event]; // no entries left for this event -> remove the empty array
  }

  // If hooks ended up empty, drop the key to leave settings as clean as we found it.
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;

  return { next, removed };
}

function main() {
  const settings = readSettings();
  const { next, removed } = plan(settings);

  log("uninstall-hooks", `target: ${SETTINGS_PATH}`);
  if (removed.length === 0) {
    log("uninstall-hooks", "none of our hooks are present — nothing to remove.");
    return;
  }
  log("uninstall-hooks", "--- entries that would be REMOVED ---");
  for (const r of removed) log("uninstall-hooks", `  [${r.event}] ${r.command}`);
  log("uninstall-hooks", "-------------------------------------");

  if (!APPLY) {
    log("uninstall-hooks", "DRY-RUN (no --apply): nothing was written.");
    return;
  }

  const bak = `${SETTINGS_PATH}.bak-${stampArg()}`;
  copyFileSync(SETTINGS_PATH, bak);
  log("uninstall-hooks", `backed up existing settings -> ${bak}`);

  const serialized = JSON.stringify(next, null, 2);
  JSON.parse(serialized); // validate before persisting
  writeFileSync(SETTINGS_PATH, serialized + "\n", "utf8");
  JSON.parse(readFileSync(SETTINGS_PATH, "utf8")); // confirm on-disk file parses
  log("uninstall-hooks", `wrote ${SETTINGS_PATH} (validated). Global gating removed.`);
}

main();
