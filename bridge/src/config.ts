// Environment-derived config. Loaded once at startup. Secrets come from .env (gitignored).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Minimal .env loader (no dependency). Only sets vars that aren't already in the environment,
// so real env always wins. Tolerates a missing file.
function loadDotEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, "..", ".env");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return; // no .env file — rely on the real environment
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function int(v: string | undefined, d: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

loadDotEnv();

const token = (process.env.BRIDGE_TOKEN || "").trim();
// A tokenless gate is not a gate — refuse to start (default-deny posture extends to boot).
if (!token) {
  throw new Error(
    "BRIDGE_TOKEN is not set. Copy bridge/.env.example to bridge/.env and set a strong token."
  );
}

export const config = {
  token,
  port: int(process.env.PORT, 4318),
  host: (process.env.HOST || "127.0.0.1").trim(),
  approvalTtlMs: int(process.env.APPROVAL_TTL_MS, 120_000),
  approvalRetainMs: int(process.env.APPROVAL_RETAIN_MS, 600_000),
  // ---- Batch 결재 / coverage (agent-authored approvals that grant coverage) ----
  // How long an APPROVED grant authorizes work (the execution window). Bounded, not infinite.
  grantTtlMs: int(process.env.GRANT_TTL_MS, 1_800_000), // 30 min
  // Hard cap on how many mutating ops one grant may authorize (server clamps the agent's request).
  grantMaxOps: int(process.env.GRANT_MAX_OPS, 100),
  // Default op budget when the batch request omits maxOps.
  grantDefaultOps: int(process.env.GRANT_DEFAULT_OPS, 30),
  eventBufferMax: int(process.env.EVENT_BUFFER_MAX, 200),
  expoPushUrl: (process.env.EXPO_PUSH_URL || "https://exp.host/--/api/v2/push/send").trim(),
  // ---- Telegram remote-approval channel (OPT-IN, purely additive) ----
  // No bot token -> channel disabled and the bridge behaves exactly as v1. Telegram never gates:
  // if send/poll fails the approval just stays pending -> TTL -> deny.
  telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
  // 1:1 mode: a private chat id (== the user id). Topics mode: a SUPERGROUP id (negative, -100…).
  telegramChatId: (process.env.TELEGRAM_CHAT_ID || "").trim(),
  // The numeric Telegram USER id allowed to resolve approvals. REQUIRED in group/topics mode,
  // where the callback's from.id is the tapping user, not the chat. Empty in 1:1 mode (the chat
  // id doubles as the user id there).
  telegramAllowedUserId: (process.env.TELEGRAM_ALLOWED_USER_ID || "").trim(),
  // When true, route each session's cards to its OWN forum topic in the supergroup. Default off
  // (1:1 mode). Accepts 1/true/on.
  telegramTopics: /^(1|true|on)$/i.test(process.env.TELEGRAM_TOPICS || ""),
  telegramEnabled: !!(process.env.TELEGRAM_BOT_TOKEN || "").trim(),
  // TEST SEAM: point this at a fake server in tests; defaults to the real Bot API.
  telegramApiBase: (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").trim(),
  telegramPollTimeoutSec: int(process.env.TELEGRAM_POLL_TIMEOUT_SEC, 30),
  // ---- Resource caps / rate limits (DoS + brute-force hardening) ----
  // Per-IP request budget over a sliding window applied to ALL /v1 routes.
  rateWindowMs: int(process.env.RATE_WINDOW_MS, 60_000),
  rateMax: int(process.env.RATE_MAX, 120),
  // Tighter per-IP budget for sensitive ops: resolve + any auth failure (token brute-force).
  rateSensitiveMax: int(process.env.RATE_SENSITIVE_MAX, 20),
  // Max concurrent SSE subscribers on GET /v1/live (overall and per source IP).
  liveMaxClients: int(process.env.LIVE_MAX_CLIENTS, 50),
  liveMaxPerIp: int(process.env.LIVE_MAX_PER_IP, 5),
  // Max distinct PENDING approvals; new creates beyond this are rejected (429).
  approvalMaxPending: int(process.env.APPROVAL_MAX_PENDING, 200),
  // Max registered devices; oldest is evicted beyond this.
  deviceMax: int(process.env.DEVICE_MAX, 50)
} as const;
