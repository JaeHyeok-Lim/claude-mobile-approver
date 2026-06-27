// Start an authenticated tunnel so the phone can reach the loopback-bound bridge
// WITHOUT exposing an open public endpoint.
//
// SECURITY MODEL (see deploy/README.md):
//   The bridge itself bearer-auths every route, so the tunnel's job is to (a) reach
//   loopback from the internet and (b) NOT add an anonymous front door that lets the
//   world brute-force the token / hammer the long-poll. We support two providers and
//   default to their authenticated modes:
//
//   cloudflare (named tunnel): a stable hostname you put behind Cloudflare Access
//                              (Zero Trust). Recommended for anything beyond a demo.
//   cloudflare (quick):        `cloudflared --url` ephemeral *.trycloudflare.com URL.
//                              Convenient but UNAUTHENTICATED at the edge — only the
//                              bridge token protects it. Allowed for short-lived local
//                              testing; the script prints a loud warning.
//   ngrok:                     uses deploy/ngrok.yml, which pins OAuth or Basic Auth on
//                              the endpoint so the edge is authenticated too.
//
// Provider + mode come from deploy/.env (TUNNEL_PROVIDER, TUNNEL_MODE) or flags.
//
// Usage:
//   node scripts/tunnel.mjs                 # provider/mode from deploy/.env
//   node scripts/tunnel.mjs --provider cloudflare --mode quick
//   node scripts/tunnel.mjs --provider ngrok
//
// On a successful public URL the script prints (to stdout, machine-readable):
//   BRIDGE_PUBLIC_URL=https://<host>
//   EXPO_PUBLIC_BRIDGE_BASE_URL=https://<host>/v1
// so `up.mjs` / a human can paste it straight into app/.env.

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadBridgeConfig, parseDotEnv, log, delay } from "./lib/common.mjs";

const DEPLOY_DIR = join(REPO_ROOT, "deploy");
const deployEnv = parseDotEnv(join(DEPLOY_DIR, ".env"));

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const provider = (flag("provider", deployEnv.TUNNEL_PROVIDER) || "cloudflare").toLowerCase();
const mode = (flag("mode", deployEnv.TUNNEL_MODE) || "quick").toLowerCase();
const cfg = loadBridgeConfig();
const localTarget = `http://127.0.0.1:${cfg.port}`;

// On Windows, cloudflared/ngrok may be installed as a .exe OR a .cmd/.bat shim (scoop/winget);
// spawn() without a shell only resolves PATHEXT shims if we give it the resolved path. So we
// resolve the real binary path ONCE via `where` (win) / `command -v` (posix) and spawn that
// directly — no shell:true, so no arg-escaping pitfalls (Node DEP0190).
function resolveBin(bin) {
  try {
    const cmd = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [bin] : ["-v", bin];
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform !== "win32" // `command` is a shell builtin on posix
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

function emitUrl(publicUrl) {
  // Machine-readable contract lines on STDOUT (everything else goes to stderr via log()).
  process.stdout.write(`BRIDGE_PUBLIC_URL=${publicUrl}\n`);
  process.stdout.write(`EXPO_PUBLIC_BRIDGE_BASE_URL=${publicUrl.replace(/\/$/, "")}/v1\n`);
}

// Match a public https URL printed by either provider.
const URL_RE = /https:\/\/[a-z0-9.-]+\.(?:trycloudflare\.com|ngrok-free\.app|ngrok\.app|ngrok\.io)[^\s"]*/i;

function watchForUrl(child, providerName) {
  let found = false;
  const scan = (buf) => {
    const text = buf.toString();
    process.stderr.write(text); // pass provider logs through to stderr
    if (found) return;
    const m = text.match(URL_RE);
    if (m) {
      found = true;
      const publicUrl = m[0].replace(/[).,]+$/, "");
      log("tunnel", `${providerName} public URL: ${publicUrl}`);
      emitUrl(publicUrl);
    }
  };
  child.stdout?.on("data", scan);
  child.stderr?.on("data", scan);
}

function startCloudflare() {
  const bin = resolveBin("cloudflared");
  if (!bin) {
    log("tunnel", "FATAL: `cloudflared` not found on PATH.");
    log("tunnel", "Install: winget install --id Cloudflare.cloudflared  (or see deploy/README.md)");
    process.exit(127);
  }

  let args;
  if (mode === "named") {
    // Stable hostname from a named tunnel + config file. Put it behind Cloudflare
    // Access so the edge is authenticated (zero anonymous reach). See deploy/cloudflared/.
    const cfgFile = join(DEPLOY_DIR, "cloudflared", "config.yml");
    if (!existsSync(cfgFile)) {
      log("tunnel", `FATAL: ${cfgFile} missing. Copy deploy/cloudflared/config.example.yml and fill it in.`);
      log("tunnel", "Setup: see deploy/README.md ‘Named tunnel + Access’ section.");
      process.exit(1);
    }
    const tunnelName = deployEnv.CF_TUNNEL_NAME;
    if (!tunnelName) {
      log("tunnel", "FATAL: CF_TUNNEL_NAME unset in deploy/.env (the named tunnel to run).");
      process.exit(1);
    }
    args = ["tunnel", "--config", cfgFile, "run", tunnelName];
    log("tunnel", `cloudflare NAMED tunnel '${tunnelName}' -> ${localTarget} (config ${cfgFile})`);
    log("tunnel", "Edge auth = Cloudflare Access policy on the hostname (configure in Zero Trust).");
  } else {
    // Quick ephemeral tunnel — UNAUTHENTICATED edge; bridge token is the only gate.
    args = ["tunnel", "--no-autoupdate", "--url", localTarget];
    log("tunnel", `cloudflare QUICK tunnel -> ${localTarget}`);
    log("tunnel", "WARNING: *.trycloudflare.com is a PUBLIC, anonymous URL. The bridge token is the");
    log("tunnel", "         ONLY thing protecting it. Use for short local testing only; for anything");
    log("tunnel", "         persistent use --mode named with Cloudflare Access. (docs/ARCHITECTURE.md)");
  }

  const child = spawn(bin, args, { cwd: DEPLOY_DIR, env: process.env });
  watchForUrl(child, "cloudflared");
  return child;
}

function startNgrok() {
  const bin = resolveBin("ngrok");
  if (!bin) {
    log("tunnel", "FATAL: `ngrok` not found on PATH.");
    log("tunnel", "Install: winget install --id Ngrok.Ngrok  (then `ngrok config add-authtoken …`)");
    process.exit(127);
  }
  const cfgFile = join(DEPLOY_DIR, "ngrok.yml");
  if (!existsSync(cfgFile)) {
    log("tunnel", `FATAL: ${cfgFile} missing. Copy deploy/ngrok.example.yml -> deploy/ngrok.yml and fill it in.`);
    log("tunnel", "It pins OAuth/Basic-Auth on the edge so the tunnel is NOT an open endpoint.");
    process.exit(1);
  }
  // Run the named endpoint defined in ngrok.yml (which carries the auth config).
  const endpoint = deployEnv.NGROK_ENDPOINT || "bridge";
  const args = ["start", "--config", cfgFile, endpoint];
  log("tunnel", `ngrok endpoint '${endpoint}' -> ${localTarget} (config ${cfgFile})`);
  log("tunnel", "Edge auth = OAuth/Basic-Auth declared in deploy/ngrok.yml.");
  const child = spawn("ngrok", args, { cwd: DEPLOY_DIR, env: process.env, ...SPAWN_OPTS });
  watchForUrl(child, "ngrok");
  return child;
}

let child;
if (provider === "cloudflare") {
  child = await startCloudflare();
} else if (provider === "ngrok") {
  child = await startNgrok();
} else {
  log("tunnel", `FATAL: unknown TUNNEL_PROVIDER '${provider}' (expected cloudflare|ngrok).`);
  process.exit(1);
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("tunnel", `received ${signal}, stopping tunnel…`);
  child.kill("SIGTERM");
  // Hard-kill backstop if the provider ignores SIGTERM.
  delay(4000).then(() => child.kill("SIGKILL"));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("error", (err) => {
  log("tunnel", `spawn error: ${err?.message || err}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  log("tunnel", `tunnel exited (code=${code} signal=${signal ?? "none"})`);
  process.exit(code ?? (signal ? 0 : 1));
});
