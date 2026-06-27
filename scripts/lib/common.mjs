// Shared, zero-dependency helpers for the run/process + tunnel scripts.
//
// Discipline (mirrors hooks/*.mjs and bridge/src/config.ts):
//   - Only `node:` builtins. No npm deps.
//   - Tolerant .env parsing (real environment always wins).
//   - Never leak the bridge token to stdout/logs.
//
// This file is imported by run-bridge.mjs / tunnel.mjs / up.mjs / health.mjs.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/lib -> repo root is two levels up.
export const REPO_ROOT = resolve(here, "..", "..");
export const BRIDGE_DIR = join(REPO_ROOT, "bridge");

/**
 * Parse a dotenv-style file into a plain object. Tolerates a missing file
 * (returns {}). Strips surrounding quotes. Does NOT mutate process.env.
 */
export function parseDotEnv(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out = {};
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
    out[key] = value;
  }
  return out;
}

/**
 * Effective bridge config: real environment wins over bridge/.env, which wins
 * over the documented defaults. Mirrors bridge/src/config.ts so the scripts and
 * the service can never disagree about host/port/token.
 */
export function loadBridgeConfig() {
  const fileEnv = parseDotEnv(join(BRIDGE_DIR, ".env"));
  const pick = (key, fallback) => {
    const fromProc = process.env[key];
    if (fromProc !== undefined && fromProc !== "") return fromProc;
    if (fileEnv[key] !== undefined && fileEnv[key] !== "") return fileEnv[key];
    return fallback;
  };
  const port = Number.parseInt(pick("PORT", "4318"), 10);
  return {
    token: (pick("BRIDGE_TOKEN", "") || "").trim(),
    host: (pick("HOST", "127.0.0.1") || "127.0.0.1").trim(),
    port: Number.isFinite(port) && port > 0 ? port : 4318
  };
}

/** Never print the token; show only that it exists and its length. */
export function tokenFingerprint(token) {
  if (!token) return "<MISSING>";
  return `present (len ${token.length})`;
}

/**
 * GET {host}:{port}/v1/healthz with bearer auth, bounded by `timeoutMs`.
 * Resolves { ok: true } on a 200 JSON {ok:true}, otherwise { ok:false, reason }.
 * Never throws.
 */
export async function probeHealth({ host, port, token, timeoutMs = 2000 }) {
  // Loopback hosts (0.0.0.0 / ::) aren't connectable as a destination — dial 127.0.0.1.
  const dialHost =
    host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  const url = `http://${dialHost}:${port}/v1/healthz`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized (token mismatch)" };
    if (!res.ok) return { ok: false, reason: `status ${res.status}` };
    const body = await res.json().catch(() => null);
    if (body && body.ok === true) return { ok: true };
    return { ok: false, reason: "unexpected health body" };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : (err?.code || err?.message || "unreachable");
    return { ok: false, reason: String(reason) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll probeHealth until ok or the budget elapses. Returns the final result.
 */
export async function waitForHealth(opts, { totalMs = 20_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + totalMs;
  let last = { ok: false, reason: "not started" };
  while (Date.now() < deadline) {
    last = await probeHealth(opts);
    if (last.ok) return last;
    await delay(intervalMs);
  }
  return last;
}

export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Timestamped, namespaced stderr log so script output never pollutes stdout contracts. */
export function log(tag, msg) {
  process.stderr.write(`[${tag}] ${msg}\n`);
}
