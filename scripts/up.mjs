// One command to bring the bridge online and reachable from the phone:
//   1. start the bridge (loopback) and WAIT until /v1/healthz is green,
//   2. then start the authenticated tunnel,
//   3. surface the public URL + the exact app/.env line to paste,
//   4. on Ctrl-C, tear down tunnel then bridge, cleanly.
//
// Sequenced AFTER the local round-trip is proven (the health gate enforces that the
// bridge is actually serving before we ever open a tunnel to it).
//
// Usage:
//   node scripts/up.mjs                       # provider/mode from deploy/.env
//   node scripts/up.mjs --provider ngrok
//   node scripts/up.mjs --provider cloudflare --mode named
//
// Pass-through flags (--provider/--mode) are forwarded to scripts/tunnel.mjs.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadBridgeConfig, tokenFingerprint, waitForHealth, log } from "./lib/common.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const cfg = loadBridgeConfig();

if (!cfg.token) {
  log("up", "FATAL: BRIDGE_TOKEN is not set. cp bridge/.env.example bridge/.env and set a token.");
  process.exit(1);
}

const children = new Set();
let shuttingDown = false;

function spawnScript(name, extraArgs = []) {
  const child = spawn(node, [join(SCRIPTS_DIR, name), ...extraArgs], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      log("up", `${name} exited unexpectedly (code=${code} signal=${signal ?? "none"}). Tearing down.`);
      shutdown("CHILD_EXIT");
    }
  });
  return child;
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("up", `shutting down (${reason})…`);
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => {
    for (const c of children) c.kill("SIGKILL");
    process.exit(0);
  }, 5000).unref?.();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// --- 1. bridge ---
log("up", `token ${tokenFingerprint(cfg.token)} | starting bridge on http://${cfg.host}:${cfg.port}`);
spawnScript("run-bridge.mjs");

// --- 2. health gate (prove local round-trip before opening the tunnel) ---
const health = await waitForHealth(
  { host: cfg.host, port: cfg.port, token: cfg.token, timeoutMs: 1500 },
  { totalMs: 30_000, intervalMs: 500 }
);
if (!health.ok) {
  log("up", `bridge never became healthy (${health.reason}). NOT opening a tunnel.`);
  shutdown("UNHEALTHY");
  process.exit(1);
}
log("up", "bridge healthy — opening authenticated tunnel.");

// --- 3. tunnel (forward provider/mode flags) ---
const passthrough = [];
for (const name of ["provider", "mode"]) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) passthrough.push(`--${name}`, process.argv[i + 1]);
}
spawnScript("tunnel.mjs", passthrough);

log("up", "stack up. Tunnel will print BRIDGE_PUBLIC_URL / EXPO_PUBLIC_BRIDGE_BASE_URL once connected.");
log("up", "Paste EXPO_PUBLIC_BRIDGE_BASE_URL into app/.env and set EXPO_PUBLIC_BRIDGE_TOKEN to match.");
log("up", "Press Ctrl-C to stop both.");
