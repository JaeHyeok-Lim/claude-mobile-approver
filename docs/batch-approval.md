# Gate modes + risk-tiered batch 결재

The gate is **selective**: routine, safe work runs autonomously; only genuinely risky work needs a
human approval. This doc explains the two modes, the risk policy, and the batch-결재 flow.

## Why the old per-call card was terse — and why risk-tiering

A `PreToolUse` hook sees only the **mechanical tool input** (file path, contents, a command string).
It cannot know *why* a change is being made — that reasoning lives in the agent, not the call — and
it fires once per call, so it can't batch. Gating **every** call also floods you with cards. So the
design is: (1) let the hook auto-allow **safe** work (autonomy), (2) require an **agent-authored,
batched 결재** only for **risky** work, and (3) never let the gate's own control plane be touched
remotely. The rich "무슨 파일로 무슨 작업 → 무슨 기능" summary is authored by the agent, which also
keeps secrets out by construction (it's a functional prose summary, not raw input).

## The two gate modes

Toggle with `node scripts/gate.mjs <mode>` (writes `bridge/.gate-mode`, read by the hook on every
call → takes effect on the next tool call, even mid-session, no restart). The file is a security
kill-switch: it is **machine-global** (all sessions share it) and can only be changed out-of-band
in a terminal — the gate never lets an agent write it.

| Mode | Command | Behavior |
|------|---------|----------|
| `off` | `gate off` | Emit `ask` → **Claude Code's native in-session prompt**. No remote gate. **Default.** |
| `batch` | `gate on` | **Risk-tiered.** Safe work auto-allowed; risky work needs an approved 결재; control-plane writes denied. |

`node scripts/gate.mjs status` shows the current mode + bridge health.

> Native in-session prompt **and** remote approval for the *same* call is impossible (Claude Code
> can't have an external tap answer a native prompt). Pick one mode per machine.

## Risk policy (what runs without a 결재 in `batch` mode)

Decided per call by the hook, in this order:

1. **Kill-switch → DENY.** Any write to `bridge/.gate-mode`, `scripts/gate.mjs`, the hook scripts,
   or the approver repo's own control plane (`bridge/**`, `scripts/**`, `hooks/**`, `.claude/**`,
   `package.json`). These change the gate itself → only editable out-of-band.
2. **The 결재-submit command → ALLOW.** `node <repo>/scripts/submit-batch.mjs …`, strictly (the
   script must be the canonical repo path and the first argument, no shell metacharacters). It only
   *creates a pending 결재* that still needs a human tap, so exempting it is safe (and breaks the
   bootstrap deadlock — otherwise you couldn't submit the first 결재).
3. **SAFE → ALLOW (autonomy).**
   - File edits (`Edit/Write/MultiEdit/NotebookEdit`) to a path **inside the project** (`cwd`
     subtree, canonicalized so `..` can't escape) that is **not** a secret/sensitive file (`.env*`,
     anything under `.git/`, `settings*.json`).
   - Bash on a **read-only / local-vcs allowlist** with **no shell metacharacters** (`; && | > $()`
     …): `ls cat grep rg git status/diff/log/show/branch/add/commit/stash/fetch` etc. **Interpreters
     and script-runners are deliberately NOT safe** (`node`, `python`, `npm run/test`, `npx`, …) —
     they execute arbitrary code and would nullify the gate; run them via an approved `bashAllow`.
4. **RISKY → needs an approved 결재.** Everything else: out-of-project or sensitive writes, and any
   bash not on the safe allowlist (installs, network, `rm`, `git push/reset`, interpreters, or
   anything with shell metacharacters). The hook `POST`s `/v1/coverage`; covered → allow (consume an
   op), else → **deny** with a hint to submit a 결재.

## Submitting a batch 결재 (agent workflow)

```sh
node scripts/submit-batch.mjs --spec <spec.json>   # blocks until approve/deny/expire (≤30 min)
```
Exit code is `0` only when **approved**.

### Spec (JSON — secrets NEVER go here)

```json
{
  "cwd": "C:/Users/you/projects/foo",
  "project": "foo",
  "title": "로그인 하드닝: 실패 429 + 상수시간 토큰검증으로 브루트포스/타이밍 방어",
  "items": [
    "auth.ts — 토큰 검증을 상수시간 비교로 교체 → 타이밍 누출 차단",
    "routes.ts — 로그인 실패 시 429 반환 → 브루트포스 방어"
  ],
  "files": ["C:/.../src/auth.ts", "C:/.../src/routes.ts"],
  "dirs":  ["C:/.../src/telegram"],
  "bashAllow": ["npm install", "git push"],
  "maxOps": 20
}
```

- `title` — **required** functional one-liner, rendered top of the card as **■ 목적**.
- `project` — display name (set explicitly; don't rely on the cwd basename).
- `sessionId` — **auto-filled** from `CLAUDE_SESSION_ID` (injected by the SessionStart hook) so the
  grant binds to *this* session; pass `--session <id>` to override. Coverage requires it to match.
- `files` / `dirs` — exact absolute paths / directory prefixes the batch may touch. A drive/filesystem
  root is rejected.
- `bashAllow` — allowed Bash command **prefixes** (matched against `prog`+`sub` only, so ≤2 tokens,
  e.g. `"git push"`, `"npm install"`; a 3-token prefix can't match). Empty = no bash.
- `maxOps` — op budget (server clamps to `GRANT_MAX_OPS`, default 100; omit → `GRANT_DEFAULT_OPS`, 30).

The Telegram card shows **■ 목적**, the project/session, the numbered items, and the **actual
enforced scope** (masked files/dirs + allowed bash prefixes with a ⚠️ blast-radius note) — you
consent to what the grant really authorizes, not just the prose.

## Coverage semantics (how the gate decides a risky call)

`POST /v1/coverage {cwd, sessionId, tool, path, prog, sub}` → covered iff an active grant:
1. is **approved**, within its execution window (`GRANT_TTL_MS`, 30 min) and has ops left (each
   covered call consumes one);
2. **same session** (required) and **same project cwd**;
3. **in scope** — file path equals a listed file / under a listed dir (canonicalized, boundary-safe);
   or Bash `prog sub` starts with an allowed `bashAllow` prefix.

Any miss / expiry / exhausted budget / bridge error → **deny** (fail-closed).

## Security posture

Default-deny everywhere; terminal grants immutable; expiry beats a racing allow; the gate's control
plane is never remotely editable; session-bound so one session's grant can't cover another; the
approval card renders the real enforced scope. See docs/ARCHITECTURE.md for the full model.

## Operational caveats

- **Session id injection is host-dependent.** `hooks/session-env.mjs` (SessionStart) writes
  `CLAUDE_SESSION_ID` to `$CLAUDE_ENV_FILE`. If your Claude Code build doesn't expose it to Bash
  subprocesses, `submit-batch` errors loudly (`session id 없음`) — pass `--session <id>` explicitly.
  Verify the SessionStart id equals the PreToolUse `session_id`.
- **`.gate-mode` is machine-global** — flipping the mode affects every session on the machine.
- Grants are **in-memory** — a bridge restart drops active grants (fail-closed).
