#!/usr/bin/env node
// Toggle the PreToolUse gate mode — a one-word command to choose HOW mutating tool calls are gated.
// Writes bridge/.gate-mode, which hooks/approve.mjs reads on EVERY call, so a change takes effect on
// the next tool call even inside a running session (no settings.json edit, no restart).
//
// Usage:
//   node scripts/gate.mjs status      # show current mode + bridge health
//   node scripts/gate.mjs off         # NATIVE Claude Code in-session permission prompt (no remote)
//   node scripts/gate.mjs on          # BATCH mode: risk-tiered — SAFE work autonomous, RISKY work
//                                       needs an approved 결재; gate-control writes denied
//   node scripts/gate.mjs batch       # (alias of `on`)
//
// This only flips the mode. It does NOT install/uninstall the hook — that's install-hooks-global.mjs.
// If the hook isn't installed globally, no session is gated regardless of this file.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_DIR, loadBridgeConfig, probeHealth, log } from "./lib/common.mjs";

const MODE_FILE = join(BRIDGE_DIR, ".gate-mode");
const VALID = new Set(["off", "batch"]);
// User-facing verb -> stored mode. `on` is the intuitive alias for the batch 결재 model.
const ALIAS = { on: "batch", off: "off", batch: "batch" };

const DESC = {
  off: "네이티브 세션 승인창 사용 (원격 게이트 꺼짐)",
  batch: "배치 결재 모드 — 안전 작업은 자율, 위험 작업만 결재 필요(게이트 제어 파일은 차단)"
};

function readMode() {
  try {
    const v = readFileSync(MODE_FILE, "utf8").trim().toLowerCase();
    if (VALID.has(v)) return v;
  } catch {
    /* no file */
  }
  return "off"; // matches approve.mjs default
}

async function printStatus() {
  const mode = readMode();
  log("gate", `현재 모드: ${mode}  (${DESC[mode]})`);
  const cfg = loadBridgeConfig();
  const health = await probeHealth({ ...cfg, timeoutMs: 2000 });
  log("gate", `bridge: ${health.ok ? "정상" : `연결 안됨 (${health.reason})`} @ 127.0.0.1:${cfg.port}`);
  if (mode !== "off" && !health.ok) {
    log("gate", "경고: 게이트가 켜져 있는데 bridge가 안 떠 있으면 변경 작업이 전부 차단됩니다.");
  }
}

async function main() {
  const arg = (process.argv[2] || "status").toLowerCase();
  if (arg === "status") return printStatus();

  const mode = ALIAS[arg];
  if (!mode) {
    log("gate", `알 수 없는 인자 "${arg}". 사용: status | off | on | batch`);
    process.exit(1);
  }
  writeFileSync(MODE_FILE, mode + "\n", "utf8");
  log("gate", `모드 -> ${mode}  (${DESC[mode]})`);
  log("gate", "다음 도구 호출부터 적용됩니다 (실행 중 세션 포함).");
  if (mode !== "off") await printStatus();
}

main().catch((err) => {
  log("gate", `error: ${err?.message ?? err}`);
  process.exit(1);
});
