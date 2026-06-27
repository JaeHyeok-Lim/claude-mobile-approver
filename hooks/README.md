# hooks/

Claude Code hook scripts that bridge a session to the mobile app. Installed by adding entries to
a **target** project's `.claude/settings.json` (or `~/.claude/settings.json` for global coverage).

Plain `.mjs`, zero-dependency. The two hooks have **opposite** failure modes by design:

- `approve.mjs` — **PreToolUse**: posts a pending tool call to the bridge, long-polls for the
  remote decision (bounded), emits `{"permissionDecision":"allow"|"deny"}`. Fails **closed** —
  **default-deny** on timeout/error/missing-token (an auto-approve bug is worse than a block).
- `notify.mjs` — **SubagentStop / Notification / PostToolUse** (event kind passed as `argv[2]`):
  fire-and-forget event POST. Fails **open** — never blocks the agent; always exits 0.
