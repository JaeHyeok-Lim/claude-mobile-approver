# Architecture — agent-mobile-bridge

## Goal

Operate Claude Code from a phone: **see what the session is doing** and **approve/deny permission
prompts anywhere**, with the approval actually gating the real action.

## Components

### 1. hooks/ — Claude Code integration (installed into target projects)
Plain `.mjs`, zero-dependency, fail-open. Installed by adding entries to a target project's
`.claude/settings.json` (and/or `~/.claude/settings.json` for global coverage).

- **`approve.mjs` (PreToolUse)** — for tool calls that need sign-off:
  1. POST `{sessionId, tool, input, cwd}` to `bridge` → get a `requestId`.
  2. Long-poll `bridge` for the decision (bounded, e.g. 120s).
  3. Emit `{"permissionDecision":"allow"}` or `{"deny"}`.
  4. On timeout/error → **default-deny** (or fall back to the local terminal prompt). Never hang
     forever.
  Scope which tools require approval via a matcher (e.g. `Bash`, `Edit`, `Write`) so read-only
  tools aren't gated.
- **`notify.mjs` (SubagentStop / Notification / PostToolUse)** — fire-and-forget POST of a
  report/status event to `bridge`. Always exit 0.

### 2. bridge/ — Node + TypeScript service
- **Approval store**: `requestId → {status: pending|allow|deny, ...}`. Endpoints: create
  (from hook), resolve (from app), poll (from hook). Default-deny on TTL expiry.
- **Event feed**: append-only recent events (subagent start/stop, notifications, reports).
- **Push**: send Expo push notifications to registered devices on new approval requests / reports.
- **Live channel**: SSE or WebSocket so the app shows live status (mirrors the desktop dashboard).
- **Auth**: shared bearer token (min). Hooks and app both authenticate.

### 3. app/ — Expo (React Native)
- Register for push (Expo push token → bridge).
- **Live feed** tab: current Claude Code / subagent activity from the event feed.
- **Approvals** tab: list pending requests with tool + summarized input + **Approve / Deny**.
  Tapping resolves the request in the bridge, which unblocks the waiting hook.

## Data flow (approval round-trip)
```
session → PreToolUse(approve.mjs) → POST /approvals → bridge stores pending
        bridge → Expo push → phone
        user taps Approve → app → POST /approvals/:id/resolve → bridge marks allow
approve.mjs long-poll → GET /approvals/:id → sees allow → emits permissionDecision:allow
        → Claude Code runs the tool
```

## Security model (critical)
- **Default-deny** everywhere: timeout, error, malformed → deny.
- Authenticate every request; rotate the shared token; consider per-device tokens later.
- Don't persist/log full tool inputs (may contain secrets) — store a redacted summary.
- The bridge is the trust boundary. Treat a compromised bridge as "attacker can approve actions"
  — keep it on a private network / authenticated tunnel, not an open public endpoint.

## Open decisions (fill as resolved)
- Hosting for `bridge` (local + tunnel like Cloudflare/ngrok vs. small cloud host).
- Push: Expo Push API (simplest) vs. raw FCM/APNs.
- Live channel: SSE (simpler) vs. WebSocket (bidirectional).
