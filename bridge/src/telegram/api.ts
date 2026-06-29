// Thin fetch-only Telegram Bot API client. Best-effort like expoPush: every call has a bounded
// AbortController timeout, swallows network/HTTP failures (returns null / [] / void), and NEVER
// throws. The bot token is a secret — it goes only in the request URL, NEVER into a log line
// (we log at most its length, never its value).
//
// Bot API: GET/POST `${apiBase}/bot${token}/${method}`.
// https://core.telegram.org/bots/api

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id: number };
    from?: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { message_id: number; chat?: { id: number } };
  };
}

export interface TelegramApi {
  sendMessage(
    chatId: string,
    text: string,
    inlineKeyboard?: InlineButton[][]
  ): Promise<{ message_id: number } | null>;
  editMessageText(chatId: string, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
}

// Redacted token fingerprint for logs: length only, never the value.
function tokenFp(token: string): string {
  return `len=${token.length}`;
}

// Escape the 3 chars that are special in Telegram's HTML parse_mode, so a dynamic value (project
// name, cwd, redacted summary) can never break the markup or inject tags. Only & < > — nothing else.
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function createTelegramApi(opts: { apiBase: string; token: string }): TelegramApi {
  const { apiBase, token } = opts;
  const base = `${apiBase}/bot${token}`;

  // Single POST helper with a timeout. Returns the parsed `result` field, or null on any failure.
  async function call<T>(method: string, body: unknown, timeoutMs: number): Promise<T | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!res.ok) {
        // 409 = another getUpdates poller is running; the caller backs off on it.
        console.warn(`[telegram] ${method} returned ${res.status} (token ${tokenFp(token)})`);
        return null;
      }
      const json = (await res.json()) as { ok?: boolean; result?: T };
      if (!json.ok) {
        console.warn(`[telegram] ${method} ok=false`);
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      // Network/timeout/abort — never propagate. Telegram delivery is not on the gate path.
      console.warn(`[telegram] ${method} failed: ${(err as Error)?.name ?? "error"}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async sendMessage(chatId, text, inlineKeyboard) {
      const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
      if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard };
      const result = await call<{ message_id: number }>("sendMessage", body, 8000);
      return result ? { message_id: result.message_id } : null;
    },

    async editMessageText(chatId, messageId, text) {
      await call(
        "editMessageText",
        { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" },
        8000
      );
    },

    async answerCallbackQuery(callbackQueryId, text) {
      const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
      if (text !== undefined) body.text = text;
      await call("answerCallbackQuery", body, 8000);
    },

    async getUpdates(offset, timeoutSec) {
      // Long-poll: the HTTP timeout sits slightly above the server-side poll so a normal empty
      // poll closes cleanly server-side rather than being aborted mid-flight.
      const result = await call<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: timeoutSec },
        (timeoutSec + 5) * 1000
      );
      return result ?? [];
    }
  };
}
