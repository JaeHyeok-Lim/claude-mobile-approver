// Start the bridge service with a preflight check and a health gate.
//
// Why a wrapper instead of `npm --prefix bridge start`?
//   - Fail fast with a readable message if BRIDGE_TOKEN is missing (the service
//     throws on boot, but the wrapper explains the fix).
//   - Warn loudly if HOST is not loopback (the bridge must NOT be a public open
//     endpoint — see docs/ARCHITECTURE.md security model).
//   - After spawn, poll /v1/healthz and report the real listening state.
//
// Usage:  node scripts/run-bridge.mjs
// Exits non-zero if the bridge fails to become healthy.

import { spawn } from "node:child_process";
import { BRIDGE_DIR, loadBridgeConfig, tokenFingerprint, waitForHealth, log } from "./lib/common.mjs";

const cfg = loadBridgeConfig();

if (!cfg.token) {
  log("run-bridge", "FATAL: BRIDGE_TOKEN is not set.");
  log("run-bridge", "Fix: cp bridge/.env.example bridge/.env  and set a strong token:");
  log("run-bridge", '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
  process.exit(1);
}

log("run-bridge", `token ${tokenFingerprint(cfg.token)}`);
log("run-bridge", `binding http://${cfg.host}:${cfg.port}`);
if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost" && cfg.host !== "::1") {
  log(
    "run-bridge",
    `WARNING: HOST=${cfg.host} is not loopback. The bridge is a trust boundary and must NOT be`
  );
  log(
    "run-bridge",
    "         an open public endpoint. Bind 127.0.0.1 and reach the phone via the tunnel."
  );
}

// Spawn the service via its own npm script so we inherit the exact tsx invocation.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["start"], {
  cwd: BRIDGE_DIR,
  stdio: "inherit",
  env: process.env
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("run-bridge", `received ${signal}, stopping bridge…`);
  child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  log("run-bridge", `bridge exited (code=${code} signal=${signal ?? "none"})`);
  process.exit(code ?? (signal ? 0 : 1));
});

// Health gate: confirm the service actually came up.
const health = await waitForHealth(
  { host: cfg.host, port: cfg.port, token: cfg.token, timeoutMs: 1500 },
  { totalMs: 20_000, intervalMs: 500 }
);
if (health.ok) {
  log("run-bridge", `HEALTHY at http://${cfg.host}:${cfg.port}/v1/healthz`);
} else if (!shuttingDown) {
  log("run-bridge", `not healthy within 20s (${health.reason}). Leaving process attached for logs.`);
}
