# claude-mobile-approver

Approve or deny **Claude Code** permission prompts — and get work reports/notifications — **from
your phone, anywhere**, with the approval actually gating the real action on your computer.

> A Node/TS bridge + Expo mobile app, wired into Claude Code through **native hooks** (no Agent
> SDK rewrite). The phone tap gates a real tool call.

## How it works (one loop)

```
Claude Code session ──hooks──► bridge ──Expo push──► phone
   ▲                                                    │
   └──── PreToolUse hook waits for your tap (Approve/Deny) ──┘
```

A `PreToolUse` hook posts a pending tool call to the bridge, you get a push, you tap
**Approve/Deny** in the app, and the hook returns that decision to Claude Code. Reports
(subagent start/stop, notifications) flow the same way, one-directionally.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data flow, schemas, and the
(security-critical) default-deny model.

## Layout

```
claude-mobile-approver/
├─ CLAUDE.md          # how to work in this repo (read first)
├─ docs/ARCHITECTURE.md
├─ hooks/             # Claude Code hook scripts (approve.mjs, notify.mjs) — installed into target projects
├─ bridge/            # Node + TypeScript service: approval store, event feed, Expo push, live channel
├─ app/               # Expo (React Native): push, live feed, approval inbox
├─ scripts/           # one-command bring-up (bridge + tunnel), health probe
└─ deploy/            # tunnel configs (cloudflared / ngrok)
```

## Quick start

```bash
# 1. bridge
cd bridge && npm install
cp .env.example .env          # set a strong BRIDGE_TOKEN (see the comment in the file)
npm run dev                   # or: node ../scripts/up.mjs  (bridge + tunnel)

# 2. install the hooks into a target project's .claude/settings.json
#    (PreToolUse → approve.mjs, SubagentStop/Notification → notify.mjs)

# 3. app
cd ../app && npm install
cp .env.example .env          # EXPO_PUBLIC_BRIDGE_BASE_URL + matching token
npx expo start                # real device / Expo Go needed for push
```

## Security

The bridge is the trust boundary. Default-deny everywhere, every request authenticated, redacted
summaries only, loopback bind behind an authenticated tunnel. A bug that auto-approves is worse
than one that blocks. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
