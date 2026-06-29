#!/usr/bin/env node
// Fire a test approval to the LOCAL bridge — node-only. Reads BRIDGE_TOKEN INSIDE node
// (via loadBridgeConfig) and hits loopback; it never puts the token on a command line.
//
// WHY this exists: an ad-hoc `powershell -ExecutionPolicy Bypass -Command` that greps the token
// out of .env, sends it as an HTTP Authorization: Bearer header, and polls in a loop has the exact
// shape of an infostealer/C2 and gets flagged by Windows Defender (Trojan:Win32/LummaStealerClick.S!MTB,
// a behavioral !MTB heuristic). Do token-authed ops in node instead. See brain:
// powershell-bypass-secret-http-trips-av / memory: no-secret-reading-shell-commands.
//
// Usage:
//   node scripts/send-test-approval.mjs [--session <id>] [--tool <name>] [--cwd <path>] [--no-wait]
import { loadBridgeConfig } from "./lib/common.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const noWait = argv.includes("--no-wait");

const { token, host, port } = loadBridgeConfig();
if (!token) { console.error("BRIDGE_TOKEN not set in bridge/.env"); process.exit(1); }
const dial = (host === "0.0.0.0" || host === "::" || host === "") ? "127.0.0.1" : host;
const base = `http://${dial}:${port}`;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

const body = {
  sessionId: arg("--session", "manual-test"),
  tool: arg("--tool", "Bash"),
  inputSummary: { kind: "bash", prog: "git", sub: "status", argc: 2 },
  cwd: arg("--cwd", process.cwd())
};

const created = await (await fetch(`${base}/v1/approvals`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
if (!created || !created.requestId) { console.error("create failed:", JSON.stringify(created)); process.exit(1); }
console.log(`approval sent -> ${created.requestId} (approve/deny it in Telegram)`);
if (noWait) process.exit(0);

const deadline = Date.now() + 100000;
let status = "pending";
while (Date.now() < deadline) {
  await sleep(2000);
  const r = await fetch(`${base}/v1/approvals/${encodeURIComponent(created.requestId)}`, { headers: H });
  if (r.ok) { status = (await r.json()).status; if (status !== "pending") break; }
}
console.log("FINAL STATUS:", status);
