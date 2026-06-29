# Architecture — claude-mobile-approver

## Goal

Operate Claude Code from a phone: **see what the session is doing** and **approve or deny
permission prompts remotely**, with the approval actually gating the real action on the computer.

## Components

### 1. hooks/ — Claude Code integration

Plain `.mjs`, zero-dependency. Installed into a target project's `.claude/settings.json` or
globally into `~/.claude/settings.json` (see [scripts/README.md](../scripts/README.md)).

- **`approve.mjs` (PreToolUse)** — the approval gate. For every tool call that matches the
  configured matcher (`Bash|Edit|Write|MultiEdit|NotebookEdit`):
  1. POST a **redacted summary** of the tool call to the bridge (`/v1/approvals`) → get a
     `requestId`.
  2. Bounded long-poll (`/v1/approvals/:id`) for the decision (budget: `APPROVE_TOTAL_MS`,
     default 10 min, matching the bridge TTL).
  3. Emit `{"permissionDecision":"allow"}` on explicit allow; deny on everything else.
  4. On timeout, network error, parse failure, or any ambiguous status → **default-deny**.
  The hook never hangs the session forever and never auto-approves on failure.

- **`notify.mjs` (SubagentStop / Notification / PostToolUse)** — fire-and-forget event reporter.
  POST a safe event summary to `/v1/events`. Always exits 0. Never blocks or gates.

- **`ensure-bridge.mjs` (SessionStart, optional)** — on session start, does a ~1 s health check
  and best-effort revives the bridge if it is down. Fail-open; never blocks the session.

### 2. bridge/ — Node + TypeScript service

Binds `127.0.0.1:4318` only (loopback). Never exposed directly to the internet.

- **Approval store** (`bridge/src/store/approvalStore.ts`): `requestId → {status:
  pending|allow|deny|expired, ...}`. TTL = 10 min. Expired entries → auto-deny. The store is
  the authoritative source of truth; every channel (HTTP, Telegram) resolves through it.
- **Routes** (`bridge/src/routes.ts`): REST endpoints on `/v1`. Auth on every request (shared
  bearer token, constant-time compare). Rate-limited.
- **Telegram channel** (`bridge/src/telegram/`): see section below.
- **Event feed** (`bridge/src/store/eventStore.ts`): append-only recent events for reporting.
- **Live channel** (`bridge/src/live/liveHub.ts`): SSE/WebSocket for live status (optional local
  dashboard; `bridge/public/index.html`).

### 3. bridge/src/telegram/ — primary remote channel

The Telegram integration is **additive and outbound-only**:

- The bridge **long-polls** `api.telegram.org/getUpdates` — pure outbound HTTPS, no inbound
  port, no tunnel, no domain, no public exposure.
- On a new pending approval, `notifyApproval()` sends a Korean card with **[승인] / [거부]**
  inline buttons to the configured `TELEGRAM_CHAT_ID`.
- The long-poll loop handles button taps (`callback_query`), authorizes the sender
  (authorize-first deny-all: both `from.id` and the message's `chat.id` must match
  `TELEGRAM_CHAT_ID`; an empty chat ID authorizes nobody), then calls
  `approvalStore.resolve(requestId, decision)`.
- After resolution the card is edited once to a terminal state: **[승인됨]**, **[거부됨]**,
  **[만료]**, or **[이미처리]**.
- A reconcile sweep runs every 15 s to catch TTL expiries and web-resolved approvals that were
  not tapped, editing their stale cards.
- `callback_data` is parsed with a strict regex (`/^(a|d):[0-9a-fA-F-]{36}$/`); anything else
  is dropped.
- Every API call has a bounded `AbortController` timeout (8 s). Network/HTTP failures are
  swallowed and logged — Telegram delivery is not on the gate path. If Telegram is unreachable
  an approval simply stays pending until TTL → default-deny.

**Card format** (Korean, HTML parse_mode, list-style):
```
[대기] 승인 요청

• 프로젝트 : <project folder name>
• 세션     : #<first 8 chars of sessionId>
• 도구     : <Korean tool label>  ⚠️   ← ⚠️ only for mutating tools (Bash/Write/Edit/…)
• 내용     :
    - <Korean abstract (e.g. "셸 명령 'git status' 실행 (총 2개 토큰)")>
    - <safe partial line (e.g. "명령: git status …")>   ← omitted if empty
• 경로     : <masked path (root + … + last 2 segments)>

만료 : <N>분 내 미응답 시 자동 거부
```
`⚠️` is the only emoji anywhere in the card. All other content is plain text or HTML tags
(`<b>`, `<code>`, `<i>`). Never raw command bodies, flag values, or file contents.

### 4. Redaction — trust boundary at the hook

Redaction is a **protocol invariant**, not a nicety. The hook holds the raw `tool_input` (which
may contain secrets in command args, flag values, or file contents). It emits only a
**structured safe partial** (`SafeInput`):

| Tool | What leaves the machine |
|---|---|
| `Bash` | Program name (gated: bare `[A-Za-z][\w.-]{0,31}` only; env-prefix / path / subshell → `(명령)`) + one plain subcommand token (no `=`, `:`, `/`, `\`, quotes, flags, ≤16 chars) + arg count |
| `Edit`, `MultiEdit`, `Write`, `Read`, `NotebookEdit` | Basename + masked path (`root + … + last 2 segments`) only. Content fields are dropped. |
| All others | Field **names** only (schema, not values). |

The bridge re-validates the incoming `SafeInput` (`bridge/src/redact.ts: coerceSafeInput()`) and
renders only from it. Full paths, command bodies, and file contents never leave the machine.

## Data flow — approval round-trip

```
Claude Code session
  │
  ├─ [tool call: Bash/Edit/Write/…]
  │
  ▼
approve.mjs (PreToolUse hook)
  │  POST /v1/approvals  { sessionId, tool, inputSummary (SafeInput), cwd }
  ▼
bridge (loopback :4318)
  │  stores pending approval (requestId, TTL=10 min)
  │  notifyApproval(view) →
  ▼
Telegram bot API (outbound long-poll)
  │  sendMessage: Korean card + [승인]/[거부] buttons → your chat
  ▼
You tap [승인] or [거부]
  │
  ▼
Telegram long-poll loop (bridge/src/telegram/poller.ts)
  │  callback_query received → authorized? → strict parse → approvalStore.resolve()
  │  editMessageText: card → [승인됨] / [거부됨]
  ▼
approve.mjs long-poll (GET /v1/approvals/:id)
  │  status = allow → emit permissionDecision:allow
  │  status = deny/expired → emit permissionDecision:deny  ← DEFAULT
  ▼
Claude Code runs or blocks the tool
```

**Timeout path**: if no decision arrives within 10 min, the store marks the entry `expired`,
the Telegram card is edited to **[만료]** by the reconcile sweep, and the hook default-denies.

## Security model

### Trust hierarchy

1. **Bridge token** (`BRIDGE_TOKEN`): shared secret, constant-time compared on every `/v1`
   request. Required at boot — the bridge refuses to start without it. The hook also
   default-denies if `BRIDGE_TOKEN` is not configured.
2. **Telegram chat ID** (`TELEGRAM_CHAT_ID`): authorize-first deny-all on every incoming button
   tap. Empty chat ID → nobody is authorized. Neither `from.id` nor `message.chat.id` alone is
   sufficient; both must match (or either must match the configured ID) and the ID must be
   non-empty.
3. **Loopback bind**: the bridge only ever listens on `127.0.0.1`. No inbound exposure.
4. **Outbound-only Telegram**: the long-poll channel is outbound HTTPS to Telegram's servers.
   No port is opened, no tunnel is needed, no domain is required.

### Default-deny everywhere

| Condition | Outcome |
|---|---|
| Bridge not started / unreachable | Hook default-denies |
| `BRIDGE_TOKEN` not set in hook env | Hook default-denies |
| Bridge boots without `BRIDGE_TOKEN` | Bridge refuses to start |
| Approval TTL (10 min) expires | Store marks `expired` → hook receives deny |
| Hook poll budget (`APPROVE_TOTAL_MS`) exhausted | Hook default-denies |
| Telegram delivery fails (network/timeout) | Approval stays pending → TTL → deny |
| `callback_data` fails strict regex | Tap is dropped; nothing resolved |
| Tap from unrecognized chat/user | Resolved to nothing; `answerCallbackQuery("권한 없음")` |
| Any parse error or ambiguous status | Hook default-denies |

### What leaves the machine

Only a **safe partial** (see Redaction above). No raw command bodies, no flag values, no file
contents, no full paths. The bot token is in every outbound HTTPS URL to `api.telegram.org` but
is never written to any log (the logger records only `len=<N>`).

### Known limitations (MVP)

- Single shared `BRIDGE_TOKEN` — no per-session or per-device tokens.
- No per-resolve audit log (resolved decisions are not persisted beyond the in-memory TTL window).
- Telegram card reconcile is best-effort; a crash between TTL expiry and reconcile leaves the
  card showing `[대기]` until the next restart + sweep.

## Auto-start (Phase 5)

The bridge can be registered as a **Windows Scheduled Task** (trigger: current user logon) via
`scripts/install-autostart.ps1`. This keeps the bridge alive across reboots with no manual
intervention. The task runs the bridge **loopback-only** — it does not install hooks and does not
gate any tool calls on its own. Gating is a separate, deliberate step.

Optional `hooks/ensure-bridge.mjs` (SessionStart) can revive a crashed bridge on session start
as a backstop. It is not installed by `install-hooks-global.mjs` and must be added manually.

## Global hook installer

`scripts/install-hooks-global.mjs` merges the approval + reporting hooks into
`~/.claude/settings.json`, gating Bash/Edit/Write/MultiEdit/NotebookEdit in **every Claude Code
session** on the machine. It is:
- **Dry-run by default** — prints what would change, writes nothing without `--apply`.
- **Idempotent** — matches entries by absolute command path; re-running never duplicates.
- **Non-destructive** — preserves all existing keys and third-party hooks; uninstall removes only
  the managed entries.

This is a deliberate, global change — review the dry-run output before applying.

## Superseded components (kept, not removed)

The following were part of an earlier design and are still present in the repo but are **no
longer required** for the primary remote channel:

- **`app/` — Expo (React Native) app**: was the primary remote interface. Now superseded by the
  Telegram bot as the remote channel. The bridge's web page (`bridge/public/index.html`) remains
  as an optional **local/LAN** dashboard — no tunnel needed since it is accessed on the same
  network.
- **`scripts/tunnel.mjs` and `deploy/` — cloudflared/ngrok tunnel**: were required to reach the
  bridge from the phone. Not needed with the outbound-only Telegram channel. The tunnel scripts
  remain for anyone who wants to expose the bridge on a private network for other purposes.
- **Cloudflare Access / token-typed web page**: the earlier remote authentication model. Replaced
  by `BRIDGE_TOKEN` + `TELEGRAM_CHAT_ID` allowlist.

## Optional: Telegram prompt input (Channels)

Claude Code's native **Channels** feature allows sending prompts from Telegram into a running
session. This is a **separate, opt-in path** — a different bot token, a different data route
(Telegram → Anthropic Channels → session), not wired into auto-start. It does not interact with
the approval bridge. See [docs/telegram-prompt-input.md](telegram-prompt-input.md).
