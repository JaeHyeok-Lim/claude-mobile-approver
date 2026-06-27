# claude-mobile-approver

Mobile remote-control bridge for **Claude Code**. Receive work reports/notifications and
**approve or deny permission prompts from your phone, anywhere** — instead of having to be at the
computer where the session runs.

Built on **native Claude Code hooks** (no Agent SDK rewrite): a `PreToolUse` hook posts the
pending tool call to a small service, you decide on your phone, and the hook returns that decision
to Claude Code.

## Architecture

Three components, one event loop:

```
Claude Code session
   │  (hooks installed into the TARGET project's .claude/settings.json)
   ├─ PreToolUse  hook → POST pending tool call → bridge ──┐   (approval request)
   ├─ SubagentStop/Notification hook → POST event → bridge │   (report/notification)
   │                                                        ▼
   │                                                   bridge/  (Node + TypeScript)
   │                                                   • approval store (pending → decided)
   │                                                   • event feed (status/reports)
   │                                                   • Expo push sender
   │                                                   • SSE live channel
   │                                                        │ push + live feed
   │                                                        ▼
   │                                                   app/  (Expo / React Native)
   │                                                   • push registration (Expo push token)
   │                                                   • live activity feed
   │                                                   • approval inbox: Approve / Deny buttons
   │                                                        │ user taps Approve/Deny
   │                                                        ▼
   └──◄ PreToolUse hook long-polls bridge for the decision, returns
        {permissionDecision: "allow"|"deny"} → Claude Code proceeds/blocks
```

**Why this shape:** Claude Code already emits hook events (`PreToolUse`, `SubagentStop`,
`Notification`), so reporting is free. The novel part is the **return path**: a `PreToolUse` hook
can itself approve/deny a tool call by emitting `permissionDecision`, so a remote phone tap can
gate a real Claude Code action with **zero SDK changes**.

### Directories
- `bridge/` — Node + TypeScript service (REST + SSE, Expo push, approval store, auth, rate limits).
- `app/` — Expo (React Native) app: push, live feed, approval inbox.
- `hooks/` — Claude Code hook scripts (`approve.mjs`, `notify.mjs`) installed into *target*
  projects' `.claude/settings.json`. Dependency-free, plain `.mjs`, and **fail-safe**: the
  reporting hook never blocks (exit 0); the approval hook fails **closed** (deny).
- `docs/ARCHITECTURE.md` — full data flow, event/approval schemas, security model.

## Commands

- `bridge/`: `npm install` then `npm run dev` (watch) or `npm start`; `npm run typecheck`; `npm test`.
- One-command bring-up: `node scripts/up.mjs` (boots the bridge, opens a tunnel). `node scripts/health.mjs` probes liveness.
- `app/`: `npm install` then `npx expo start` (needs a real device / Expo Go for push).
- Validate settings JSON: `python -m json.tool .claude/settings.json`

## Conventions

- **TypeScript** for `bridge/` and `app/`. **Hook scripts stay plain `.mjs`**, zero-dependency.
- The **bridge wire contract is the single source of truth** (`bridge/src/contracts/`). Clients
  (app, hooks) must match it — re-declaring DTO shapes client-side lets them drift silently past
  the type checker. Test every boundary path, not just the happy one.
- Secrets (Expo push keys, bridge auth token) live in `.env` (gitignored); commit only `.env.example`.
- **Verify, don't assume**: after a change, actually run the bridge / hook round-trip and report
  the real result.

## Guardrails (don't)

- **The bridge is security-critical** — it is the trust boundary. A bug that auto-approves is far
  worse than one that blocks:
  - Default-**deny** on timeout / error / ambiguity, at every layer (including boot: refuse to
    start without a token).
  - Authenticate **every** request (shared bearer token; constant-time, length-independent compare).
  - Rate-limit and cap resources — don't assume the tunnel edge will throttle (quick-tunnel mode
    has no edge auth).
  - Never log or persist full tool inputs (may contain secrets) — only redacted, value-free summaries.
- Don't let the `PreToolUse` hook hang the session forever — bound the long-poll and fail closed
  (deny) on timeout.
- Don't write hook scripts that throw / exit non-zero on transient errors for *reporting* events —
  those must never block the agent.
- Don't commit `.env`, Expo credentials, or push tokens.

## Security model

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: bind loopback, expose only behind an
authenticated tunnel / private network, default-deny everywhere, redacted summaries only. The
shared token is a single point of compromise — per-device tokens and resolver auditing are noted
as known MVP limitations.
