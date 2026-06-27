// One-shot authenticated health probe of the local bridge.
// Useful in CI smoke tests and for "is it up?" from the terminal.
//
// Usage:  node scripts/health.mjs
// Exit 0 if /v1/healthz returns {ok:true} with the configured token; non-zero otherwise.

import { loadBridgeConfig, probeHealth, log } from "./lib/common.mjs";

const cfg = loadBridgeConfig();
if (!cfg.token) {
  log("health", "BRIDGE_TOKEN not set — cannot auth the probe.");
  process.exit(2);
}

const res = await probeHealth({ host: cfg.host, port: cfg.port, token: cfg.token, timeoutMs: 3000 });
if (res.ok) {
  log("health", `OK http://${cfg.host}:${cfg.port}/v1/healthz`);
  process.exit(0);
}
log("health", `DOWN (${res.reason}) http://${cfg.host}:${cfg.port}/v1/healthz`);
process.exit(1);
