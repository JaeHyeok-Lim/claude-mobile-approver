#!/usr/bin/env node
// Submit a rich BATCH 결재 to the local bridge and wait for the mobile/web decision. This is the
// agent-facing "결재" command used in gate mode "batch": describe a chunk of planned work (each
// item a one-liner: 파일·기능·수정방식·결정·근거), name the files/dirs/bash it will touch, and get
// ONE approval that then lets the PreToolUse hook pass those operations silently.
//
// Token is read INSIDE node (never on a command line) via loadBridgeConfig — same AV-safe posture
// as send-test-approval.mjs. The rich spec is passed as a JSON FILE (multi-line safe), not argv.
//
// Usage:
//   node scripts/submit-batch.mjs --spec <path-to-spec.json> [--no-wait]
//   node scripts/submit-batch.mjs < spec.json            # spec on stdin
//
// Spec JSON (secrets NEVER go here — only a functional summary):
//   {
//     "cwd": "C:/Users/.../project",       // defaults to process.cwd()
//     "sessionId": "…",                     // optional; tightens coverage to one session
//     "title": "인증 흐름 리팩터",
//     "items": [
//       "auth.ts (토큰 검증): 상수시간 비교로 교체 — 타이밍 누출 차단이 근거",
//       "routes.ts (로그인 라우트): 실패시 429 반환 — 브루트포스 방어 결정"
//     ],
//     "files": ["C:/…/src/auth.ts", "C:/…/src/routes.ts"],
//     "dirs":  ["C:/…/src/telegram"],       // optional dir prefixes
//     "bash":  true,                          // whether bash is covered
//     "maxOps": 20                            // op budget (server clamps)
//   }

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { loadBridgeConfig, log } from "./lib/common.mjs";

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
};
const noWait = argv.includes("--no-wait");

function readSpec() {
  const specPath = arg("--spec");
  const raw = specPath ? readFileSync(specPath, "utf8") : readFileSync(0, "utf8");
  const spec = JSON.parse(raw);
  if (!spec || typeof spec !== "object") throw new Error("spec must be a JSON object");
  if (!Array.isArray(spec.items) || spec.items.length === 0) {
    throw new Error("spec.items must be a non-empty array of summary lines");
  }
  if (typeof spec.title !== "string" || !spec.title.trim()) {
    throw new Error("spec.title is required");
  }
  return spec;
}

const { token, host, port } = loadBridgeConfig();
if (!token) {
  log("submit-batch", "BRIDGE_TOKEN not set in bridge/.env");
  process.exit(1);
}
const dial = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
const base = `http://${dial}:${port}`;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

let spec;
try {
  spec = readSpec();
} catch (err) {
  log("submit-batch", `bad spec: ${err?.message ?? err}`);
  process.exit(1);
}

const body = {
  cwd: typeof spec.cwd === "string" && spec.cwd ? spec.cwd : process.cwd(),
  // Treat an empty/blank sessionId as absent so it doesn't look like a session-scoped grant.
  sessionId: typeof spec.sessionId === "string" && spec.sessionId.trim() ? spec.sessionId.trim() : undefined,
  title: spec.title,
  items: spec.items,
  files: Array.isArray(spec.files) ? spec.files : [],
  dirs: Array.isArray(spec.dirs) ? spec.dirs : [],
  bash: spec.bash === true,
  maxOps: typeof spec.maxOps === "number" ? spec.maxOps : undefined
};

// Bridge calls are wrapped: in batch mode the bridge may well be down, and this CLI should exit
// cleanly with a reason (exit 1), never crash with an unhandled rejection.
async function postJson(url, payload) {
  try {
    const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(payload) });
    return await r.json().catch(() => null);
  } catch (err) {
    log("submit-batch", `bridge unreachable (${err?.cause?.code || err?.message || err}). Is it running?`);
    process.exit(1);
  }
}

const created = await postJson(`${base}/v1/batches`, body);
if (!created || !created.batchId) {
  log("submit-batch", `create failed: ${JSON.stringify(created)}`);
  process.exit(1);
}
log("submit-batch", `결재 요청 전송 -> ${created.batchId} (텔레그램/웹에서 승인/거부하세요)`);
if (noWait) process.exit(0);

// Poll until the batch leaves "pending" or the decision window closes. A transient poll error is
// tolerated (keep trying until the deadline), matching the hook's default-deny-on-timeout posture.
const deadline = Date.now() + 15 * 60 * 1000; // safety cap well past the pending TTL
let status = "pending";
while (Date.now() < deadline) {
  await sleep(2000);
  try {
    const r = await fetch(`${base}/v1/batches/${encodeURIComponent(created.batchId)}`, { headers: H });
    if (r.ok) {
      status = (await r.json()).status;
      if (status !== "pending") break;
    }
  } catch {
    /* transient — keep polling until the deadline */
  }
}
log("submit-batch", `FINAL STATUS: ${status}`);
// Exit non-zero unless approved, so a caller can gate on it.
process.exit(status === "allow" ? 0 : 1);
