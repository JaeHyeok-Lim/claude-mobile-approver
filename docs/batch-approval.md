# Batch 결재 + coverage gate

Approve **a whole chunk of planned work at once**, with a rich, human-readable summary — instead of
tapping one terse card per tool call. The mechanism, and why it has to be shaped this way, are below.

## Why the card used to say only "파일 생성/덮어쓰기"

The `PreToolUse` hook only ever sees the **mechanical tool input** (`file_path`, contents, a command
string). It does *not* know *what a file is for*, *how it fits the plan*, or *why a decision was made* —
that reasoning lives in the agent, not the tool call. It also fires **once per call**, so it can't
group related operations. Therefore a rich, batched, rationale-carrying approval **must be authored by
the agent**, not derived by the hook.

That is also *safer*: because the agent writes a **functional summary in prose**, secrets (tokens, API
keys, raw file/command bodies) simply aren't in it. The redaction invariant still holds — raw tool
input never leaves the machine.

## The three gate modes

Toggle with `node scripts/gate.mjs <mode>`. The hook reads `bridge/.gate-mode` on **every** call, so a
change applies to the **next tool call even in a running session** — no restart.

| Mode    | Command             | Behavior |
|---------|---------------------|----------|
| `off`   | `gate off`          | The hook emits `ask` → **Claude Code's native in-session permission prompt**. No remote gate. |
| `batch` | `gate on`           | **Coverage mode.** Only tool calls covered by an **approved batch 결재** pass (silently). Anything uncovered is **denied**. |
| `each`  | `gate each`         | Legacy: one remote approval card per mutating call (create + long-poll). **Default** when no mode file exists. |

> Native in-session prompt **and** remote approval **for the same call** is *not possible* — Claude
> Code has no way for an external tap to answer the native prompt (verified against the docs). So it's
> one or the other per session; `gate off`/`gate on` is how you choose.

Check state anytime: `node scripts/gate.mjs status`.

## Using batch mode (the agent workflow)

In `batch` mode, before doing mutating work the agent submits a 결재 and waits for approval:

```sh
node scripts/submit-batch.mjs --spec <spec.json>     # blocks until approve/deny/expire
node scripts/submit-batch.mjs --spec <spec.json> --no-wait   # fire and return
```

Exit code is `0` only when **approved**, so a caller can gate on it.

### Spec format (JSON — secrets NEVER go here)

```json
{
  "cwd": "C:/Users/you/projects/foo",
  "project": "foo",
  "sessionId": "optional-session-id",
  "title": "로그인 하드닝: 실패 429 + 상수시간 토큰검증으로 브루트포스/타이밍 방어",
  "items": [
    "auth.ts — 토큰 검증을 상수시간 비교로 교체 → 타이밍 누출 차단",
    "routes.ts — 로그인 실패 시 429 반환 → 브루트포스 방어",
    "config.ts — RATE_MAX 기본값 120 유지 → 기존 부하와 호환"
  ],
  "files": ["C:/.../src/auth.ts", "C:/.../src/routes.ts", "C:/.../src/config.ts"],
  "dirs":  ["C:/.../src/telegram"],
  "bash":  true,
  "maxOps": 20
}
```

- `title` — **REQUIRED functional one-liner**, rendered at the very top of the card as **■ 목적**:
  *무슨 파일로 무슨 작업을 해서 무슨 기능을 하는지* in the user's terms. This is the first thing the
  approver reads.
- `project` — display name shown on the card. **Set it explicitly** — don't rely on the cwd
  basename (a session run from a home/parent dir would otherwise show e.g. `jaehyeok`).
- `items` — one line each: **어떤 파일을 — 무슨 작업 → 어떤 기능/근거**. Nothing omitted
  (functionally); the card can be long. Rendered verbatim (HTML-escaped).
- `files` — exact absolute paths the batch may touch (Edit/Write/MultiEdit/NotebookEdit).
- `dirs` — directory prefixes; any file under one is covered.
- `bash` — whether Bash calls are covered by this batch.
- `maxOps` — op budget; the server clamps to `GRANT_MAX_OPS` (default 100). Omit → `GRANT_DEFAULT_OPS` (30).

## Coverage semantics (how the gate decides)

`POST /v1/coverage {cwd, sessionId, tool, path}` → an active grant covers the call iff **all**:

1. the grant is **approved**, within its **execution window** (`GRANT_TTL_MS`, default 30 min), and has
   **remaining ops** (each covered call consumes one);
2. **same project** — normalized `cwd` matches (and, when both name a session, the sessions match);
3. **in scope** — a file tool's path equals a listed file or sits under a listed dir; a Bash call
   requires `bash: true`.

Any miss, expiry, exhausted budget, or bridge error → **not covered → the hook default-denies**. Path
comparison is normalized (backslashes→`/`, trailing slash dropped, lowercased) and prefix matches are
boundary-safe (`src` never matches `src2`).

## Security posture (unchanged invariants)

- Default-**deny** everywhere; expiry beats a racing allow; terminal grants are immutable.
- `bash: true` is the widest grant — it authorizes *any* Bash for the batch (bounded by `maxOps` +
  TTL). Keep `maxOps` tight; the human sees the stated purpose in `items`.
- The grant is **cwd-scoped**, so an approval for one project can't authorize work in another.
- Coverage is auth-gated like every `/v1` route and consumes a bounded budget (no infinite reuse).
