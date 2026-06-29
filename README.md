# claude-mobile-approver

Approve or deny **Claude Code** permission prompts — and get work reports/notifications — **from
your phone**, with the approval actually gating the real action on your computer.

The primary remote channel is a **Telegram bot**: the bridge long-polls Telegram's servers
outbound only, so there is no inbound port to open, no tunnel to manage, and no public exposure.

> Built on native Claude Code hooks — no Agent SDK rewrite. The phone tap gates a real tool call.

## How it works

```
Claude Code session
  │
  ├─ PreToolUse hook ──POST──► bridge (loopback)
  │                                │
  │                         Telegram bot API (outbound long-poll)
  │                                │
  │                         [승인] / [거부] inline buttons on phone
  │                                │
  └──◄── hook long-polls bridge for decision ◄── tap resolves approval store
         emits permissionDecision → Claude Code runs or blocks the tool
```

A `PreToolUse` hook posts a redacted summary of the pending tool call to the bridge. The bridge
sends a Korean approval card to your Telegram chat. You tap **[승인]** (approve) or **[거부]**
(deny). The hook is long-polling the bridge and picks up the decision; Claude Code proceeds or
blocks accordingly. Reports (subagent stop, notifications) flow one-way the same path.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data flow, schemas, and the
security/threat model.

## Layout

```
claude-mobile-approver/
├─ CLAUDE.md              # how to work in this repo (conventions, guardrails, commands)
├─ docs/
│   ├─ ARCHITECTURE.md    # data flow, security model, threat model
│   └─ telegram-prompt-input.md  # opt-in: send prompts INTO a session via Telegram Channels
├─ hooks/                 # Claude Code hook scripts installed into target projects
│   ├─ approve.mjs        # PreToolUse — approval gate (fail-closed)
│   ├─ notify.mjs         # SubagentStop / Notification / PostToolUse — fire-and-forget report
│   └─ ensure-bridge.mjs  # SessionStart — optional bridge reviver
├─ bridge/                # Node + TypeScript service: approval store, Telegram channel, auth
├─ scripts/               # bridge runner, Windows auto-start, global hook installer
├─ app/                   # Expo (React Native) — superseded as primary channel; optional local use
└─ deploy/                # tunnel configs — no longer required for Telegram channel
```

## Quick start

### 1. Create a Telegram bot

Chat with `@BotFather` → `/newbot`. Note the bot token. Then start a chat with the bot and send
`/start` — the bridge will echo your `chat_id` back.

### 2. Configure the bridge

```sh
cd bridge
npm install
cp .env.example .env
# Edit .env — set:
#   BRIDGE_TOKEN       a strong random secret (openssl rand -hex 32 or similar)
#   TELEGRAM_BOT_TOKEN the token from @BotFather
#   TELEGRAM_CHAT_ID   your chat id (send /start to the bot; the bridge logs it)
```

### 3. Start the bridge

```sh
# Development:
npm run dev

# Or with the production runner (token preflight included):
node ../scripts/run-bridge.mjs

# Or register as a Windows Scheduled Task (starts at logon, loopback-only):
pwsh ../scripts/install-autostart.ps1
```

Check it is healthy: `node scripts/health.mjs`

### 4. Install hooks into a target project

Add to the target project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{
          "type": "command",
          "command": "node \"/path/to/agent-mobile-bridge/hooks/approve.mjs\"",
          "env": { "BRIDGE_URL": "http://127.0.0.1:4318", "BRIDGE_TOKEN": "<your token>" }
        }]
      }
    ]
  }
}
```

Or install globally (gates **all** sessions on this machine — read the warning first):

```sh
node scripts/install-hooks-global.mjs          # dry-run: review what will change
node scripts/install-hooks-global.mjs --apply  # apply after reviewing
```

### 5. Test it

Run Claude Code in the target project and trigger a Bash or Edit tool call. A Korean approval
card should appear in your Telegram chat. Tap **[승인]** to allow or **[거부]** to deny.

## Optional: send prompts into a session from Telegram

Claude Code's native **Channels** feature (a separate, opt-in path) lets you send prompts from
Telegram directly into a running session. This is independent of the approval bot — a different
bot token, a different data path, not wired into auto-start. See
[docs/telegram-prompt-input.md](docs/telegram-prompt-input.md).

## Security

The bridge is the trust boundary. Default-deny everywhere, every `/v1` request authenticated,
redacted summaries only, loopback bind with no inbound exposure. The Telegram channel is
outbound-only — no tunnel, no open port. A bug that auto-approves is worse than one that blocks.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
