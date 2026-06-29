// Telegram remote-approval channel. PURELY ADDITIVE and resolves through the EXISTING approval
// store — it adds zero new state and zero new trust. The bridge's gate never depends on it: if
// send/poll fails an approval simply stays pending until TTL -> default-deny.
//
// Two halves:
//   notifyApproval(view) — push a redacted approval card with [ 승인 ]/[ 거부 ] inline buttons to
//                          the chat. TEXT-favored Korean format (HTML parse_mode); the ONLY emoji
//                          anywhere is the ⚠️ risk prefix for mutating tools.
//   start()/stop()       — a single long-poll getUpdates loop turning button taps into
//                          approvals.resolve(...) calls, AFTER authorizing the sender. The same
//                          loop also reconciles tracked cards whose store state went terminal on
//                          its own (TTL expiry, or a resolve via the web app) by editing them ONCE.
//
// SECURITY: authorize-first (deny-all). Until TELEGRAM_CHAT_ID is set, or if the tap comes from
// any other chat/user, we resolve NOTHING. callback_data is parsed with a strict regex. Only the
// store decides outcomes; we just translate taps and mirror the resolve route's side-effects via
// the shared notifyResolved helper, so the two channels can't drift.

import type { ApprovalView, Decision } from "../contracts/index.js";
import type { EventStore } from "../store/eventStore.js";
import type { ApprovalStore } from "../store/approvalStore.js";
import type { LiveHub } from "../live/liveHub.js";
import { notifyResolved } from "../routes.js";
import { abstractKo, koreanToolLabel, maskPath, safePartial } from "../redact.js";
import { createTelegramApi, escapeHtml, type TelegramApi, type TelegramUpdate } from "./api.js";

export interface TelegramChannel {
  notifyApproval(view: ApprovalView): void;
  start(): void;
  stop(): void;
  // Translate a single update into (at most) one store resolve. Public so tests can drive the
  // security-critical paths without spinning a real network loop.
  handle(update: TelegramUpdate): Promise<void>;
}

interface TelegramConfig {
  telegramBotToken: string;
  telegramChatId: string;
  telegramApiBase: string;
  telegramPollTimeoutSec: number;
  // Group/topics knobs (additive; both empty/false == 1:1 mode, exactly as v1).
  telegramAllowedUserId: string;
  telegramTopics: boolean;
}

export interface TelegramDeps {
  approvals: ApprovalStore;
  events: EventStore;
  live: LiveHub;
  config: TelegramConfig;
  // Injectable for tests; defaults to the real fetch-based client.
  api?: TelegramApi;
}

// Strict callback_data: action prefix + a UUID (the requestId). Anything else is dropped.
const CALLBACK_RE = /^(a|d):([0-9a-fA-F-]{36})$/;

// Cap the requestId -> tracked-card map so a flood of approvals can't grow it unbounded.
const MESSAGE_MAP_CAP = 200;

// How often the poll loop reconciles tracked cards against the store (TTL-expiry / web-resolve).
const RECONCILE_MS = 15_000;

// Tools that MUTATE state (run code / write files). Only these get the ⚠️ risk prefix — the one
// sanctioned emoji in the whole card. Everything else is plain TEXT.
const RISKY_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

// The display context we keep per tracked request so an edited card (decision/expiry/web-resolve)
// can re-render the body verbatim and only swap the leading status tag + the bottom line.
// Every field here is already REDACTED / safe to show — see redact.ts (abstractKo/safePartial are
// built only from the value-free SafeInput; maskedPath collapses the path's middle).
interface CardContext {
  messageId: number;
  projectName: string;
  shortSession: string;
  riskMark: string; // "  ⚠️" for mutating tools, else ""
  toolLabel: string; // koreanToolLabel(tool)
  abstract: string; // line 1 of 내용 (Korean abstract)
  partial: string; // line 2 of 내용 (safe partial; may be "")
  maskedPath: string; // 경로 line (masked)
  // Forum threadId this card lives in (topics mode), so edits target the same topic. undefined in
  // 1:1 mode or when sending to the General topic (no thread id).
  threadId?: number;
  // Set once we've edited the card into a terminal state, so reconcile never re-edits it.
  edited?: boolean;
}

// Last path segment of a cwd, tolerating both \ and / separators. Empty/missing -> a TEXT fallback.
function projectNameOf(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.at(-1) ?? "(작업폴더 없음)";
}

// "  ⚠️" ONLY for mutating tools (the one sanctioned emoji); plain "" otherwise.
function riskMarkFor(tool: string): string {
  return RISKY_TOOLS.has(tool) ? "  ⚠️" : "";
}

// Static expiry line computed at send time (no live countdown). TEXT only, no emoji.
function expiryLine(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec >= 60) return `만료 : <b>${Math.round(sec / 60)}분</b> 내 미응답 시 자동 거부`;
  return `만료 : <b>${sec}초</b> 내 미응답 시 자동 거부`;
}

// Render the list-style card body. `statusTag` is the bracketed status word at line start; `lastLine`
// is the bottom expiry/status line. Lines 1–3 (the header + 프로젝트/세션/도구 + 내용/경로) are
// identical across pending and every edited state — only the tag and the last line swap.
function renderCard(ctx: CardContext, statusTag: string, lastLine: string): string {
  const lines = [
    `[${statusTag}] 승인 요청`,
    "",
    `• 프로젝트 : <b>${escapeHtml(ctx.projectName)}</b>`,
    `• 세션     : <code>#${escapeHtml(ctx.shortSession)}</code>`,
    `• 도구     : ${escapeHtml(ctx.toolLabel)}${ctx.riskMark}`,
    "• 내용     :",
    `    - ${escapeHtml(ctx.abstract)}`
  ];
  if (ctx.partial) lines.push(`    - ${escapeHtml(ctx.partial)}`);
  lines.push(`• 경로     : <i>${escapeHtml(ctx.maskedPath)}</i>`, "", lastLine);
  return lines.join("\n");
}

export function createTelegramChannel(deps: TelegramDeps): TelegramChannel {
  const { approvals, events, live, config } = deps;
  const api =
    deps.api ??
    createTelegramApi({ apiBase: config.telegramApiBase, token: config.telegramBotToken });

  // requestId -> the chat card we sent + the display context to re-render it, so the outcome can
  // edit that exact card (lines 1–3 verbatim, status tag + line 4 swapped).
  const messages = new Map<string, CardContext>();

  // TOPICS MODE: sessionId -> forum threadId. Filled lazily on the first approval per session via
  // api.createForumTopic; reused for every later card/edit of that session. A failed create caches
  // the GENERAL_TOPIC sentinel so we fall back (no thread id) and never retry-create. In-memory
  // only: a bridge restart re-creates topics for ongoing sessions (acceptable for MVP).
  const sessionThreads = new Map<string, number | undefined>();
  // Sentinel for "topic creation failed / unavailable — send to the General topic (no thread id)".
  const GENERAL_TOPIC = -1;

  let running = false;
  let stopped = false;
  let offset = 0;
  let lastReconcile = 0;

  // L-1: topics mode without an allowed user id is fail-CLOSED (deny-all), but it's almost
  // certainly a misconfig — warn loudly so the operator sets the numeric user id.
  if (config.telegramTopics && !config.telegramAllowedUserId) {
    console.warn(
      "[telegram] TELEGRAM_TOPICS is on but TELEGRAM_ALLOWED_USER_ID is empty — every tap will be denied. Set it to your numeric Telegram user id."
    );
  }

  function rememberMessage(requestId: string, ctx: CardContext): void {
    if (messages.size >= MESSAGE_MAP_CAP) {
      const oldest = messages.keys().next().value;
      if (oldest !== undefined) messages.delete(oldest);
    }
    messages.set(requestId, ctx);
  }

  // Cap sessionThreads the same way (FIFO). Prevents unbounded map growth / forum-topic creation
  // when a long-lived process sees many distinct sessionIds. Evicting a stale entry just means a
  // reappearing old session gets a fresh topic — harmless.
  function rememberThread(sessionId: string, val: number | undefined): void {
    if (sessionThreads.size >= MESSAGE_MAP_CAP) {
      const oldest = sessionThreads.keys().next().value;
      if (oldest !== undefined) sessionThreads.delete(oldest);
    }
    sessionThreads.set(sessionId, val);
  }

  function notifyApproval(view: ApprovalView): void {
    // Build the card from REDACTED fields only — never raw tool input. abstractKo/safePartial are
    // derived from the value-free SafeInput; for file tools the masked path comes from the safe
    // pathMasked, otherwise from the cwd masked the same way (always useful, always masked).
    const cwd = view.cwd ?? "";
    const safe = view.safeInput;
    const cwdMasked = cwd ? maskPath(cwd) : "(작업폴더 없음)";
    // File tools carry their own masked path; everything else shows the masked cwd.
    const maskedPath = safe?.kind === "file" ? safe.pathMasked : cwdMasked;
    const ctxBase = {
      projectName: cwd ? projectNameOf(cwd) : "(작업폴더 없음)",
      shortSession: view.sessionId.slice(0, 8),
      riskMark: riskMarkFor(view.tool),
      toolLabel: koreanToolLabel(view.tool),
      abstract: abstractKo(view.tool, safe),
      partial: safePartial(safe),
      maskedPath
    };
    const text = renderCard(
      { ...ctxBase, messageId: 0 },
      "대기",
      expiryLine(view.expiresAt)
    );
    const keyboard = [
      [
        { text: "승인", callback_data: `a:${view.requestId}` },
        { text: "거부", callback_data: `d:${view.requestId}` }
      ]
    ];
    // Fire-and-forget: must not throw or block the create path.
    void (async () => {
      // In topics mode, resolve (lazily creating) this session's forum thread first. undefined =>
      // 1:1 mode or General-topic fallback — send with no thread id, exactly as v1. The thread
      // resolver is only awaited when topics is ON, so 1:1 mode keeps its original send timing.
      const threadId = config.telegramTopics
        ? await resolveThread(view.sessionId, ctxBase.projectName, ctxBase.shortSession)
        : undefined;
      const sent = await api.sendMessage(config.telegramChatId, text, keyboard, threadId);
      if (sent)
        rememberMessage(view.requestId, { ...ctxBase, messageId: sent.message_id, threadId });
    })();
  }

  // Resolve the forum threadId for a session (topics mode only). Lazily creates the topic on the
  // FIRST approval per session and caches it; reuses it thereafter. On create failure (bot not
  // admin / not a forum / API error) it logs ONCE and caches the GENERAL_TOPIC sentinel so we fall
  // back to the General topic and never retry-create. Returns undefined => send with NO thread id
  // (1:1 mode or General fallback). Best-effort; never throws.
  async function resolveThread(
    sessionId: string,
    projectName: string,
    shortSession: string
  ): Promise<number | undefined> {
    if (!config.telegramTopics) return undefined; // 1:1 mode: never thread
    const cached = sessionThreads.get(sessionId);
    if (cached !== undefined) return cached === GENERAL_TOPIC ? undefined : cached;
    const name = `${projectName} #${shortSession}`;
    const topic = await api.createForumTopic(config.telegramChatId, name);
    if (topic) {
      rememberThread(sessionId, topic.message_thread_id);
      return topic.message_thread_id;
    }
    // Failed: cache the sentinel (no retry) and fall back to the General topic.
    console.warn(
      `[telegram] createForumTopic failed for session ${shortSession} — falling back to General topic`
    );
    rememberThread(sessionId, GENERAL_TOPIC);
    return undefined;
  }

  // Edit a tracked card into one of its terminal states ONCE, then mark it edited so neither a
  // later tap nor the reconcile sweep re-edits it. Best-effort; never throws (api swallows errors).
  async function editTerminal(
    requestId: string,
    tag: string,
    line4: string
  ): Promise<void> {
    const ctx = messages.get(requestId);
    if (!ctx || ctx.edited) return;
    ctx.edited = true;
    await api.editMessageText(
      config.telegramChatId,
      ctx.messageId,
      renderCard(ctx, tag, line4),
      ctx.threadId
    );
  }

  // Authorize a button tap (deny-all). The allowlist of permitted resolver USER ids is
  // [telegramAllowedUserId] when set (group/topics mode — the callback's from.id is the actual
  // tapping user, NOT the chat), else [telegramChatId] (1:1 mode, where chat.id == user id). A tap
  // is authorized ONLY when its from.id (stringified) matches a NON-EMPTY allowlist entry. Empty
  // config => empty allowlist => authorize nobody (bootstrap deny-all). In group mode, group
  // MEMBERSHIP is NOT sufficient — we never authorize by chat.id, so another member tapping is
  // rejected.
  function isAuthorized(cq: NonNullable<TelegramUpdate["callback_query"]>): boolean {
    const allow = config.telegramAllowedUserId || config.telegramChatId;
    if (allow === "") return false; // bootstrap: nobody
    const fromId = cq.from?.id;
    return fromId !== undefined && String(fromId) === allow;
  }

  // Translate one update into (at most) one resolve. Exposed for tests.
  async function handle(update: TelegramUpdate): Promise<void> {
    // (a) Bootstrap: /start reveals the chat_id so the operator can fill TELEGRAM_CHAT_ID.
    if (update.message?.text === "/start") {
      const id = update.message.chat?.id;
      if (id !== undefined) {
        console.log(`Telegram chat_id: ${id} — put this in TELEGRAM_CHAT_ID`);
        void api.sendMessage(String(id), `chat_id: ${id}\nTELEGRAM_CHAT_ID 에 넣으세요.`);
      }
      return;
    }

    // (b) Only button taps are actionable.
    const cq = update.callback_query;
    if (!cq) return;

    // AUTHORIZE FIRST (deny-all).
    if (!isAuthorized(cq)) {
      await api.answerCallbackQuery(cq.id, "권한 없음");
      return; // resolve NOTHING
    }

    // (c) Strict callback_data parse.
    const m = cq.data ? CALLBACK_RE.exec(cq.data) : null;
    if (!m) {
      await api.answerCallbackQuery(cq.id);
      return;
    }
    // (d) action -> decision.
    const decision: Decision = m[1] === "a" ? "allow" : "deny";
    const requestId = m[2]!;

    // (e) Resolve through the store and branch on its discriminated result. The card is re-rendered
    // (lines 1–3 verbatim) with the new status tag + line 4 via editTerminal.
    const result = approvals.resolve(requestId, decision);
    if (result.ok) {
      notifyResolved({ events, live }, result.view, decision);
      if (decision === "allow") {
        await editTerminal(requestId, "승인됨", "<b>승인됨</b>");
        await api.answerCallbackQuery(cq.id, "승인됨");
      } else {
        await editTerminal(requestId, "거부됨", "<b>거부됨</b>");
        await api.answerCallbackQuery(cq.id, "거부됨");
      }
      return;
    }
    // Failure branches mirror the HTTP resolve route's semantics.
    if (result.reason === "expired") {
      await editTerminal(requestId, "만료", "<b>만료됨</b> · 자동 거부");
      await api.answerCallbackQuery(cq.id, "만료됨");
    } else if (result.reason === "already_resolved") {
      await editTerminal(requestId, "이미처리", "<b>이미 처리됨</b>");
      await api.answerCallbackQuery(cq.id, "이미 처리됨");
    } else {
      // not_found — nothing tracked to edit.
      await api.answerCallbackQuery(cq.id, "알 수 없는 요청");
    }
  }

  // Reconcile tracked cards against the store: any whose state went terminal on its own — TTL
  // expiry, or a resolve via the web app — gets edited ONCE then dropped from the map, so an
  // untapped expired card never shows a stale "대기" forever. Best-effort, idempotent, never throws.
  async function reconcile(): Promise<void> {
    for (const [requestId, ctx] of [...messages]) {
      if (ctx.edited) {
        messages.delete(requestId);
        continue;
      }
      const view = approvals.get(requestId);
      if (!view || view.status === "pending") continue;
      if (view.status === "allow") {
        await editTerminal(requestId, "승인됨", "<b>승인됨</b>");
      } else if (view.status === "deny") {
        await editTerminal(requestId, "거부됨", "<b>거부됨</b>");
      } else {
        // "expired"
        await editTerminal(requestId, "만료", "<b>만료됨</b> · 자동 거부");
      }
      messages.delete(requestId);
    }
  }

  // Throttle reconcile to ~RECONCILE_MS regardless of poll cadence. Best-effort; swallows errors.
  async function maybeReconcile(): Promise<void> {
    const now = Date.now();
    if (now - lastReconcile < RECONCILE_MS) return;
    lastReconcile = now;
    try {
      await reconcile();
    } catch (err) {
      console.warn(`[telegram] reconcile failed: ${(err as Error)?.name ?? "error"}`);
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      await maybeReconcile();
      const updates = await api.getUpdates(offset, config.telegramPollTimeoutSec);
      if (stopped) break;
      if (updates.length === 0) {
        // Empty poll (a normal long-poll timeout) OR a swallowed network/HTTP error (incl. the
        // 409 another poller would trigger — api.ts logs that status). Brief backoff so a
        // persistent failure can't hot-loop; a normal empty poll already cost ~timeout seconds.
        await sleep(2000);
        continue;
      }
      for (const update of updates) {
        // Advance PAST every update, even ones we drop, so we never reprocess a rejected tap.
        if (update.update_id >= offset) offset = update.update_id + 1;
        try {
          await handle(update);
        } catch (err) {
          // A handler hiccup must not kill the loop.
          console.warn(`[telegram] handle failed: ${(err as Error)?.name ?? "error"}`);
        }
      }
    }
    running = false;
  }

  function start(): void {
    if (running) return; // idempotent — only one loop per process
    running = true;
    stopped = false;
    void loop();
  }

  function stop(): void {
    stopped = true;
  }

  return { notifyApproval, start, stop, handle };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
