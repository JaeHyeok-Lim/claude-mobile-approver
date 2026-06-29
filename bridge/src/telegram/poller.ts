// Telegram remote-approval channel. PURELY ADDITIVE and resolves through the EXISTING approval
// store — it adds zero new state and zero new trust. The bridge's gate never depends on it: if
// send/poll fails an approval simply stays pending until TTL -> default-deny.
//
// Two halves:
//   notifyApproval(view) — push a redacted approval card with ✅/❌ inline buttons to the chat.
//   start()/stop()       — a single long-poll getUpdates loop turning button taps into
//                          approvals.resolve(...) calls, AFTER authorizing the sender.
//
// SECURITY: authorize-first (deny-all). Until TELEGRAM_CHAT_ID is set, or if the tap comes from
// any other chat/user, we resolve NOTHING. callback_data is parsed with a strict regex. Only the
// store decides outcomes; we just translate taps and mirror the resolve route's side-effects via
// the shared notifyResolved helper, so the two channels can't drift.

import { basename } from "node:path";
import type { ApprovalView, Decision } from "../contracts/index.js";
import type { EventStore } from "../store/eventStore.js";
import type { ApprovalStore } from "../store/approvalStore.js";
import type { LiveHub } from "../live/liveHub.js";
import { notifyResolved } from "../routes.js";
import { createTelegramApi, type TelegramApi, type TelegramUpdate } from "./api.js";

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

// Cap the requestId -> message_id map so a flood of approvals can't grow it unbounded.
const MESSAGE_MAP_CAP = 200;

function relativeExpiry(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "만료됨";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}초 후 만료`;
  return `${Math.round(sec / 60)}분 후 만료`;
}

export function createTelegramChannel(deps: TelegramDeps): TelegramChannel {
  const { approvals, events, live, config } = deps;
  const api =
    deps.api ??
    createTelegramApi({ apiBase: config.telegramApiBase, token: config.telegramBotToken });

  // requestId -> the chat message we sent, so the outcome can edit that exact card.
  const messages = new Map<string, number>();

  let running = false;
  let stopped = false;
  let offset = 0;

  function rememberMessage(requestId: string, messageId: number): void {
    if (messages.size >= MESSAGE_MAP_CAP) {
      const oldest = messages.keys().next().value;
      if (oldest !== undefined) messages.delete(oldest);
    }
    messages.set(requestId, messageId);
  }

  function notifyApproval(view: ApprovalView): void {
    // Build the card from REDACTED fields only — never raw tool input.
    const dir = view.cwd ? basename(view.cwd) : "(no cwd)";
    const label = `📁 ${dir} #${view.sessionId.slice(0, 8)} — ${view.tool} · ${view.summary}`;
    const text = `${label}\n⏳ ${relativeExpiry(view.expiresAt)}`;
    const keyboard = [
      [
        { text: "✅ 승인", callback_data: `a:${view.requestId}` },
        { text: "❌ 거부", callback_data: `d:${view.requestId}` }
      ]
    ];
    // Fire-and-forget: must not throw or block the create path.
    void (async () => {
      const sent = await api.sendMessage(config.telegramChatId, text, keyboard);
      if (sent) rememberMessage(view.requestId, sent.message_id);
    })();
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

    // AUTHORIZE FIRST (deny-all). Empty chatId = bootstrap mode = authorize nobody. Both the
    // tapping user and the message's chat must match the configured chat id.
    const chatId = config.telegramChatId;
    const fromId = cq.from?.id;
    const msgChatId = cq.message?.chat?.id;
    const authorized =
      chatId !== "" &&
      ((fromId !== undefined && String(fromId) === chatId) ||
        (msgChatId !== undefined && String(msgChatId) === chatId));
    if (!authorized) {
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
    const requestId = m[2] as string;
    const messageId = messages.get(requestId);

    // (e) Resolve through the store and branch on its discriminated result.
    const result = approvals.resolve(requestId, decision);
    if (result.ok) {
      notifyResolved({ events, live }, result.view, decision);
      if (messageId !== undefined) {
        await api.editMessageText(
          chatId,
          messageId,
          decision === "allow" ? "✅ 승인됨" : "❌ 거부됨"
        );
      }
      await api.answerCallbackQuery(cq.id, decision === "allow" ? "승인됨" : "거부됨");
      return;
    }
    // Failure branches mirror the HTTP resolve route's semantics.
    if (result.reason === "expired") {
      if (messageId !== undefined) {
        await api.editMessageText(chatId, messageId, "⌛ 만료됨 (자동 거부)");
      }
      await api.answerCallbackQuery(cq.id, "만료됨");
    } else if (result.reason === "already_resolved") {
      if (messageId !== undefined) {
        await api.editMessageText(chatId, messageId, "이미 처리됨");
      }
      await api.answerCallbackQuery(cq.id, "이미 처리됨");
    } else {
      // not_found
      await api.answerCallbackQuery(cq.id, "알 수 없는 요청");
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
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
