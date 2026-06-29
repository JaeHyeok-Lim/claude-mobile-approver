#!/usr/bin/env node
// OPTIONAL SessionStart hook: make sure the approval bridge is up before a session starts.
// Zero-dependency, fail-OPEN, bounded. It NEVER blocks session start and NEVER throws.
//
// Behaviour:
//   1. Fast (~1s) authenticated GET http://127.0.0.1:4318/v1/healthz.
//   2. Healthy  -> exit 0 (do nothing).
//   3. Down     -> best-effort spawn `node scripts/run-bridge.mjs` DETACHED, then exit 0.
// We only spawn when the health check FAILED, so we never start a duplicate bridge.
//
// This is a convenience: the autostart Scheduled Task (scripts/install-autostart.ps1) is the
// primary way to keep the bridge running. This hook just covers the "task not installed / bridge
// crashed" gap so the approval gate isn't left default-denying.
//
// Wiring (OPTIONAL — add to ~/.claude/settings.json, e.g. via your own edit):
//   "hooks": {
//     "SessionStart": [
//       { "hooks": [ { "type": "command",
//                      "command": "node \"<abs repo>/hooks/ensure-bridge.mjs\"",
//                      "env": { "BRIDGE_TOKEN": "<token>" } } ] }
//     ]
//   }
// install-hooks-global.mjs does NOT wire this hook — it's left to the user by design.
//
// Config via env:
//   BRIDGE_URL    base URL of the bridge   (default http://127.0.0.1:4318)
//   BRIDGE_TOKEN  shared bearer token      (used for the health probe; missing -> still spawns)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_URL = (process.env.BRIDGE_URL || "http://127.0.0.1:4318").replace(/\/+$/, "");
const TOKEN = process.env.BRIDGE_TOKEN || "";

// hooks/ -> repo root is one level up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_BRIDGE = join(REPO_ROOT, "scripts", "run-bridge.mjs");

async function isHealthy() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1000); // ~1s budget — never stall a session
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/healthz`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal: ac.signal
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return !!(body && body.ok === true);
  } catch {
    return false; // unreachable / timeout -> treat as down
  } finally {
    clearTimeout(timer);
  }
}

function spawnBridgeDetached() {
  if (!existsSync(RUN_BRIDGE)) return; // nothing to start; stay silent and exit 0
  try {
    const child = spawn(process.execPath, [RUN_BRIDGE], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: "ignore", // fully detach so the session doesn't wait on bridge output
      windowsHide: true
    });
    child.unref(); // let the session exit/continue independently of the bridge
  } catch {
    /* best-effort only — a failed spawn must never block session start */
  }
}

async function main() {
  if (await isHealthy()) return; // already up -> no duplicate spawn
  spawnBridgeDetached();
}

// Whatever happens, exit 0. This hook assists; it never gates.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
