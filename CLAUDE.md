# claude-mobile-approver

Remote approval bridge for **Claude Code**. A `PreToolUse` hook posts pending tool calls to a
local Node/TS bridge; you approve or deny from your phone via **Telegram**; the hook returns that
decision to Claude Code and the tool runs or is blocked.

Built entirely on native Claude Code hooks — no Agent SDK rewrite required.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data flow, security model, and
threat model.

One-line summary: hook → loopback bridge → Telegram bot (outbound-only long-poll, no public port)
→ inline-button tap → bridge resolves → hook returns `permissionDecision`.

### Directories

- `bridge/` — Node + TypeScript service: approval store, event feed, Telegram channel, live
  channel, auth, rate limits.
- `hooks/` — Claude Code hook scripts (`approve.mjs`, `notify.mjs`). Plain `.mjs`,
  zero-dependency, fail-safe.
- `scripts/` — Bridge runner, auto-start (Windows Scheduled Task), global hook installer.
  See [scripts/README.md](scripts/README.md).
- `docs/` — Architecture, Telegram prompt-input guide, handoff notes.
- `app/` — Expo (React Native) app. **Superseded as the primary remote channel** by Telegram;
  kept for optional local/LAN use. See Architecture doc for details.
- `deploy/` — Tunnel configs (cloudflared / ngrok). No longer required for the Telegram channel.

## Commands

```sh
# bridge — development
cd bridge && npm install
npm run dev          # watch mode
npm start            # production
npm run typecheck
npm test

# bridge — production runner (with token preflight)
node scripts/run-bridge.mjs

# health check
node scripts/health.mjs

# auto-start at logon (Windows Scheduled Task, loopback-only, no gating)
pwsh scripts/install-autostart.ps1

# global hook installer (gates Bash|Edit|Write|MultiEdit|NotebookEdit in ALL sessions)
node scripts/install-hooks-global.mjs           # dry-run first — always
node scripts/install-hooks-global.mjs --apply   # write after reviewing

# validate settings JSON
python -m json.tool .claude/settings.json
```

## Conventions

- **TypeScript** for `bridge/`. **Hook scripts stay plain `.mjs`**, zero-dependency.
- The **bridge wire contract is the single source of truth** (`bridge/src/contracts/`). Clients
  (hooks) must match it — re-declaring DTO shapes client-side lets them drift silently past the
  type checker. Test every boundary path, not just the happy one.
- Secrets (`BRIDGE_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) live in `bridge/.env`
  (gitignored). Commit only `.env.example`. Never echo secret values into chat or logs.
- **Verify, don't assume**: after a change, actually run the bridge / hook round-trip and report
  the real result.
- **Redaction is a protocol invariant**: the hook sends a structured safe partial (program name +
  plain subcommand for Bash; basename + masked path for file tools; field names only for others)
  and the bridge renders only from that. Raw command bodies, flag values, and file contents never
  leave the machine.

## Guardrails (don't)

- **The bridge is security-critical** — it is the trust boundary. A bug that auto-approves is far
  worse than one that blocks:
  - Default-**deny** on timeout, error, and ambiguity at every layer (including boot: refuse to
    start without a token).
  - Authenticate **every** `/v1` request (shared bearer token; constant-time, length-independent
    compare).
  - Rate-limit and cap resources; do not assume any edge will throttle.
  - Never log or persist raw tool inputs (may contain secrets) — only redacted, value-free
    summaries.
- Don't let the `PreToolUse` hook hang the session forever — the poll budget is bounded
  (`APPROVE_TOTAL_MS`, default 10 min = bridge TTL); on expiry it default-denies.
- Don't write hook scripts that throw / exit non-zero on transient errors for *reporting* events —
  those must never block the agent.
- Don't commit `.env`, tokens, or secrets of any kind.
- **Global hook installer warning**: `install-hooks-global.mjs --apply` gates Bash/Edit/Write/
  MultiEdit/NotebookEdit in **all** Claude Code sessions on this machine. Dry-run and review
  before applying; revert with `uninstall-hooks-global.mjs --apply`.

## Security model

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: bridge binds loopback only; Telegram
channel is outbound-only (no inbound port, no tunnel, no public exposure); default-deny
everywhere; authorize-first deny-all on the Telegram channel (TELEGRAM_CHAT_ID allowlist);
redacted summaries only. The shared `BRIDGE_TOKEN` is a single point of compromise — treat it
accordingly.
