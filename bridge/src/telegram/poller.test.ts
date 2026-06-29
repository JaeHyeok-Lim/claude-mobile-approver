// Security-path tests for the Telegram channel's handle(): authorize-first deny-all, strict
// callback parsing, and the resolve result branches. We drive handle() directly with a stubbed
// api (no network, no poll loop) and a real ApprovalStore, asserting the store ACTUALLY resolved
// (or did NOT) — the calls into the api are recorded so we can check edits/answers too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "../store/approvalStore.js";
import { EventStore } from "../store/eventStore.js";
import { LiveHub } from "../live/liveHub.js";
import { createTelegramChannel } from "./poller.js";
import type { TelegramApi, TelegramUpdate } from "./api.js";

const CHAT = "123456";

// Records every api call so tests can assert the side-effects (edits/answers/sends).
function fakeApi(opts: { topicFails?: boolean } = {}) {
  const calls = {
    sends: [] as Array<{ chatId: string; text: string; threadId?: number }>,
    edits: [] as Array<{ messageId: number; text: string; threadId?: number }>,
    answers: [] as Array<{ id: string; text?: string }>,
    topics: [] as Array<{ chatId: string; name: string }>
  };
  let nextMessageId = 1000;
  let nextThreadId = 5000;
  const api: TelegramApi = {
    async sendMessage(chatId, text, _keyboard, threadId) {
      calls.sends.push({ chatId, text, threadId });
      return { message_id: nextMessageId++ };
    },
    async editMessageText(_chatId, messageId, text, threadId) {
      calls.edits.push({ messageId, text, threadId });
    },
    async answerCallbackQuery(id, text) {
      calls.answers.push({ id, text });
    },
    async getUpdates() {
      return [];
    },
    async createForumTopic(chatId, name) {
      calls.topics.push({ chatId, name });
      if (opts.topicFails) return null;
      return { message_thread_id: nextThreadId++ };
    }
  };
  return { api, calls };
}

function setup(chatId = CHAT) {
  const approvals = new ApprovalStore({ ttlMs: 60_000, retainMs: 60_000 });
  const events = new EventStore({ max: 50 });
  const live = new LiveHub({ maxClients: 10, maxPerIp: 10 });
  const { api, calls } = fakeApi();
  const channel = createTelegramChannel({
    approvals,
    events,
    live,
    api,
    config: {
      telegramBotToken: "test-token",
      telegramChatId: chatId,
      telegramApiBase: "http://fake.invalid",
      telegramPollTimeoutSec: 1,
      telegramAllowedUserId: "",
      telegramTopics: false
    }
  });
  return { approvals, events, channel, calls };
}

function seedPending(approvals: ApprovalStore) {
  return approvals.create({ tool: "Bash", summary: "Bash · 1 field", sessionId: "sess-abcdef12" });
}

function tap(requestId: string, action: "a" | "d", overrides: Partial<TelegramUpdate> = {}) {
  const base: TelegramUpdate = {
    update_id: 1,
    callback_query: {
      id: "cbq1",
      data: `${action}:${requestId}`,
      from: { id: Number(CHAT) },
      message: { message_id: 1000, chat: { id: Number(CHAT) } }
    }
  };
  return { ...base, ...overrides };
}

test("authorized allow resolves the request and edits the card", async () => {
  const { approvals, events, channel, calls } = setup();
  const view = seedPending(approvals);
  // notifyApproval first so the requestId -> message_id map is populated for the edit. The fake
  // assigns message_id 1000 to the first send.
  channel.notifyApproval(view);
  await Promise.resolve(); // let the fire-and-forget send settle

  await channel.handle(tap(view.requestId, "a"));

  assert.equal(approvals.get(view.requestId)?.status, "allow");
  // Decision mirrored into the feed (notifyResolved).
  assert.ok(events.list().some((e) => e.kind === "Decision"));
  assert.ok(calls.edits.some((e) => e.messageId === 1000 && e.text.includes("승인")));
  assert.ok(calls.answers.some((a) => a.id === "cbq1"));
});

test("authorized deny resolves to deny", async () => {
  const { approvals, channel } = setup();
  const view = seedPending(approvals);
  channel.notifyApproval(view);
  await Promise.resolve();
  await channel.handle(tap(view.requestId, "d"));
  assert.equal(approvals.get(view.requestId)?.status, "deny");
});

test("unauthorized chat is dropped — resolves NOTHING and answers '권한 없음'", async () => {
  const { approvals, channel, calls } = setup();
  const view = seedPending(approvals);
  const evil: TelegramUpdate = {
    update_id: 2,
    callback_query: {
      id: "cbq-evil",
      data: `a:${view.requestId}`,
      from: { id: 999999 }, // not the configured chat
      message: { message_id: 5, chat: { id: 999999 } }
    }
  };
  await channel.handle(evil);
  assert.equal(approvals.get(view.requestId)?.status, "pending"); // untouched
  assert.ok(calls.answers.some((a) => a.id === "cbq-evil" && a.text === "권한 없음"));
  assert.equal(calls.edits.length, 0);
});

test("bootstrap mode (empty chatId) authorizes nobody", async () => {
  const { approvals, channel, calls } = setup("");
  const view = seedPending(approvals);
  await channel.handle(tap(view.requestId, "a"));
  assert.equal(approvals.get(view.requestId)?.status, "pending");
  assert.ok(calls.answers.some((a) => a.text === "권한 없음"));
});

test("bad callback_data is dropped (no resolve)", async () => {
  const { approvals, channel, calls } = setup();
  const view = seedPending(approvals);
  const bad: TelegramUpdate = {
    update_id: 3,
    callback_query: {
      id: "cbq-bad",
      data: "x:not-a-uuid",
      from: { id: Number(CHAT) },
      message: { message_id: 7, chat: { id: Number(CHAT) } }
    }
  };
  await channel.handle(bad);
  assert.equal(approvals.get(view.requestId)?.status, "pending");
  // Authorized but unparseable -> we answer (dismiss the spinner) but never edit/resolve.
  assert.ok(calls.answers.some((a) => a.id === "cbq-bad"));
  assert.equal(calls.edits.length, 0);
});

test("expired request -> '만료됨' branch, never flipped to allow", async () => {
  const approvals = new ApprovalStore({ ttlMs: 0, retainMs: 60_000 }); // expired immediately
  const events = new EventStore({ max: 50 });
  const live = new LiveHub({ maxClients: 10, maxPerIp: 10 });
  const { api, calls } = fakeApi();
  const channel = createTelegramChannel({
    approvals,
    events,
    live,
    api,
    config: {
      telegramBotToken: "t",
      telegramChatId: CHAT,
      telegramApiBase: "http://fake.invalid",
      telegramPollTimeoutSec: 1,
      telegramAllowedUserId: "",
      telegramTopics: false
    }
  });
  const view = approvals.create({ tool: "Bash", summary: "s", sessionId: "x" });
  channel.notifyApproval(view);
  await Promise.resolve();
  await channel.handle(tap(view.requestId, "a"));
  assert.equal(approvals.get(view.requestId)?.status, "expired"); // never allow
  assert.ok(calls.answers.some((a) => a.text === "만료됨"));
});

test("already-resolved (double tap) -> '이미 처리됨', no state flip", async () => {
  const { approvals, channel, calls } = setup();
  const view = seedPending(approvals);
  channel.notifyApproval(view);
  await Promise.resolve();
  // First tap: deny.
  await channel.handle(tap(view.requestId, "d"));
  assert.equal(approvals.get(view.requestId)?.status, "deny");
  // Second tap on the other button: must NOT flip to allow.
  await channel.handle(tap(view.requestId, "a"));
  assert.equal(approvals.get(view.requestId)?.status, "deny");
  assert.ok(calls.answers.some((a) => a.text === "이미 처리됨"));
});

test("not_found request -> '알 수 없는 요청'", async () => {
  const { channel, calls } = setup();
  const fakeId = "00000000-0000-0000-0000-000000000000";
  await channel.handle(tap(fakeId, "a"));
  assert.ok(calls.answers.some((a) => a.text === "알 수 없는 요청"));
});

// ---- Card rendering: the safe partial must never carry a raw value ----

// Build the channel with the same wiring as setup(), but resolve a notifyApproval send so we can
// read the exact card text that would be pushed to Telegram.
async function renderSentCard(view: import("../contracts/index.js").ApprovalView): Promise<string> {
  const approvals = new ApprovalStore({ ttlMs: 600_000, retainMs: 600_000 });
  const events = new EventStore({ max: 50 });
  const live = new LiveHub({ maxClients: 10, maxPerIp: 10 });
  const { api, calls } = fakeApi();
  const channel = createTelegramChannel({
    approvals,
    events,
    live,
    api,
    config: {
      telegramBotToken: "t",
      telegramChatId: CHAT,
      telegramApiBase: "http://fake.invalid",
      telegramPollTimeoutSec: 1,
      telegramAllowedUserId: "",
      telegramTopics: false
    }
  });
  channel.notifyApproval(view);
  await Promise.resolve();
  return calls.sends.at(-1)?.text ?? "";
}

test("Bash card shows the Korean abstract + safe partial, NEVER the secret-bearing args", async () => {
  // A bash approval whose safeInput was produced by the hook's redact(): prog+sub+argc only.
  // The original command was e.g. `npm publish --token sk-SECRET --registry https://r.internal`.
  const view = {
    requestId: "11111111-1111-1111-1111-111111111111",
    tool: "Bash",
    status: "pending" as const,
    summary: "Bash · 1 field (command)",
    safeInput: { kind: "bash" as const, prog: "npm", sub: "publish", argc: 6 },
    cwd: "C:\\Users\\alice\\projects\\agent-mobile-bridge\\bridge",
    sessionId: "abcdef1234567890",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
  const card = await renderSentCard(view);
  // Korean abstract + safe partial present.
  assert.ok(card.includes("셸 명령 실행"), "tool label");
  assert.ok(card.includes("셸 명령 'npm publish' 실행 (총 6개 토큰)"), "abstract");
  assert.ok(card.includes("명령: npm publish …"), "safe partial");
  assert.ok(card.includes("⚠️"), "risk mark for Bash");
  // SECURITY: the secret token / flags / registry must appear NOWHERE in the card.
  assert.ok(!card.includes("sk-SECRET"), "secret leaked into card");
  assert.ok(!card.includes("--token"));
  assert.ok(!card.includes("r.internal"));
  // cwd is masked (middle collapsed).
  assert.ok(card.includes("C:\\…\\agent-mobile-bridge\\bridge"), "masked cwd");
  assert.ok(!card.includes("alice"), "full cwd middle leaked");
});

test("Edit card masks a deep path and shows only the basename", async () => {
  const view = {
    requestId: "22222222-2222-2222-2222-222222222222",
    tool: "Edit",
    status: "pending" as const,
    summary: "Edit · 3 fields",
    safeInput: {
      kind: "file" as const,
      basename: "config.ts",
      pathMasked: "C:\\…\\src\\config.ts"
    },
    cwd: "C:\\Users\\alice\\projects\\secret-app",
    sessionId: "sess-deadbeef",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
  const card = await renderSentCard(view);
  assert.ok(card.includes("파일 수정"), "tool label");
  assert.ok(card.includes("파일 수정: config.ts"), "abstract with basename");
  assert.ok(card.includes("파일: config.ts"), "safe partial");
  assert.ok(card.includes("C:\\…\\src\\config.ts"), "masked file path on 경로 line");
  assert.ok(card.includes("⚠️"), "risk mark for Edit");
  // The deep middle of the real path must not surface (we only ever sent the masked form).
  assert.ok(!card.includes("Users\\alice\\projects"), "deep path leaked");
});

test("legacy/missing safeInput still renders (backward-tolerant) without a partial line", async () => {
  const view = {
    requestId: "33333333-3333-3333-3333-333333333333",
    tool: "Read",
    status: "pending" as const,
    summary: "Read · 1 field",
    // no safeInput (old hook) — card must still render.
    cwd: "/srv/app",
    sessionId: "x",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
  const card = await renderSentCard(view);
  assert.ok(card.includes("파일 읽기"), "falls back to tool label");
  assert.ok(card.includes("[대기] 승인 요청"));
  assert.ok(card.includes("/srv/app"), "short cwd shown as-is");
});

// ---- Supergroup + per-session Topics mode ----

const GROUP = "-1001234567890"; // a supergroup id
const ALLOWED_USER = "777"; // the one user permitted to resolve in group mode

// Build a channel in topics mode (supergroup + allowed user). topicFails simulates a bot that
// can't create topics (not admin / Topics off) -> General-topic fallback.
function setupTopics(opts: { topicFails?: boolean } = {}) {
  const approvals = new ApprovalStore({ ttlMs: 60_000, retainMs: 60_000 });
  const events = new EventStore({ max: 50 });
  const live = new LiveHub({ maxClients: 10, maxPerIp: 10 });
  const { api, calls } = fakeApi(opts);
  const channel = createTelegramChannel({
    approvals,
    events,
    live,
    api,
    config: {
      telegramBotToken: "test-token",
      telegramChatId: GROUP,
      telegramApiBase: "http://fake.invalid",
      telegramPollTimeoutSec: 1,
      telegramAllowedUserId: ALLOWED_USER,
      telegramTopics: true
    }
  });
  return { approvals, events, channel, calls };
}

// Let the fire-and-forget notifyApproval chain settle (createForumTopic -> sendMessage = a couple
// of microtask hops).
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("topics: a topic is created once per session and reused, cards carry its message_thread_id", async () => {
  const { approvals, channel, calls } = setupTopics();
  // Two approvals in the SAME session.
  const v1 = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-aaaaaaaa1111" });
  const v2 = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-aaaaaaaa1111" });
  channel.notifyApproval(v1);
  await flush();
  channel.notifyApproval(v2);
  await flush();

  // Exactly ONE topic created for the session, reused for both cards.
  assert.equal(calls.topics.length, 1, "topic created once per session");
  const threadId = 5000;
  assert.equal(calls.sends.length, 2);
  assert.ok(
    calls.sends.every((s) => s.threadId === threadId),
    "both cards carry the same message_thread_id"
  );
  assert.ok(calls.sends.every((s) => s.chatId === GROUP), "cards sent to the supergroup");
  // Topic name = projectName + #shortSession (no cwd here -> the no-folder fallback).
  assert.ok(calls.topics[0]?.name.includes("#sess-aaa"), "topic name carries the short session");
});

test("topics: a SECOND session gets its OWN topic", async () => {
  const { approvals, channel, calls } = setupTopics();
  const a = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-aaaaaaaa" });
  const b = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-bbbbbbbb" });
  channel.notifyApproval(a);
  await flush();
  channel.notifyApproval(b);
  await flush();
  assert.equal(calls.topics.length, 2, "one topic per distinct session");
  assert.equal(calls.sends[0]?.threadId, 5000);
  assert.equal(calls.sends[1]?.threadId, 5001);
});

test("topics: edits target the same thread as the card", async () => {
  const { approvals, channel, calls } = setupTopics();
  const view = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-cccccccc" });
  channel.notifyApproval(view);
  await flush();
  const threadId = calls.sends.at(-1)?.threadId;
  assert.equal(threadId, 5000);
  // Authorized resolve -> edit must carry the same thread id.
  await channel.handle({
    update_id: 1,
    callback_query: {
      id: "cbq-topic",
      data: `a:${view.requestId}`,
      from: { id: Number(ALLOWED_USER) },
      message: { message_id: 1000, chat: { id: Number(GROUP) } }
    }
  });
  assert.equal(approvals.get(view.requestId)?.status, "allow");
  assert.ok(calls.edits.some((e) => e.threadId === threadId), "edit targets the card's thread");
});

test("topics: createForumTopic failure falls back to General topic (no thread id), never retries", async () => {
  const { approvals, channel, calls } = setupTopics({ topicFails: true });
  const v1 = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-dddddddd" });
  const v2 = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-dddddddd" });
  channel.notifyApproval(v1);
  await flush();
  channel.notifyApproval(v2);
  await flush();
  // Tried once, cached the sentinel, did NOT retry on the second card.
  assert.equal(calls.topics.length, 1, "create attempted once then cached as failed");
  assert.equal(calls.sends.length, 2);
  assert.ok(
    calls.sends.every((s) => s.threadId === undefined),
    "fallback cards carry NO thread id (General topic)"
  );
});

test("group auth: an allowlisted user's tap is accepted and resolves", async () => {
  const { approvals, channel } = setupTopics();
  const view = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-eeeeeeee" });
  channel.notifyApproval(view);
  await flush();
  await channel.handle({
    update_id: 1,
    callback_query: {
      id: "cbq-ok",
      data: `a:${view.requestId}`,
      from: { id: Number(ALLOWED_USER) },
      message: { message_id: 1000, chat: { id: Number(GROUP) } }
    }
  });
  assert.equal(approvals.get(view.requestId)?.status, "allow");
});

test("group auth: a NON-allowlisted member (group member, wrong from.id) is REJECTED, resolves nothing", async () => {
  const { approvals, channel, calls } = setupTopics();
  const view = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-ffffffff" });
  channel.notifyApproval(view);
  await flush();
  // Another member of the SAME supergroup taps. msgChatId matches the group, but from.id is NOT
  // the allowed user -> must be rejected (group membership is not sufficient).
  await channel.handle({
    update_id: 2,
    callback_query: {
      id: "cbq-intruder",
      data: `a:${view.requestId}`,
      from: { id: 888 }, // a different group member
      message: { message_id: 1000, chat: { id: Number(GROUP) } }
    }
  });
  assert.equal(approvals.get(view.requestId)?.status, "pending", "untouched");
  assert.ok(
    calls.answers.some((a) => a.id === "cbq-intruder" && a.text === "권한 없음"),
    "rejected with 권한 없음"
  );
  assert.ok(!calls.edits.some((e) => e.text.includes("승인")), "no terminal edit");
});

test("group auth: a tap whose from.id matches the GROUP chat id (not the user) is REJECTED", async () => {
  // Defense: in group mode we must never authorize by chat.id. A spoofed from.id == the group id
  // is not the allowed user -> reject.
  const { approvals, channel, calls } = setupTopics();
  const view = approvals.create({ tool: "Bash", summary: "s", sessionId: "sess-gggggggg" });
  channel.notifyApproval(view);
  await flush();
  await channel.handle({
    update_id: 3,
    callback_query: {
      id: "cbq-chatid",
      data: `a:${view.requestId}`,
      from: { id: Number(GROUP) }, // the chat id, NOT the allowed user id
      message: { message_id: 1000, chat: { id: Number(GROUP) } }
    }
  });
  assert.equal(approvals.get(view.requestId)?.status, "pending");
  assert.ok(calls.answers.some((a) => a.id === "cbq-chatid" && a.text === "권한 없음"));
});

test("/start bootstrap logs/sends the chat_id and resolves nothing", async () => {
  const { channel, calls } = setup();
  const update: TelegramUpdate = {
    update_id: 4,
    message: { text: "/start", chat: { id: 555 } }
  };
  await channel.handle(update);
  assert.ok(calls.sends.some((s) => s.text.includes("555")));
  assert.equal(calls.answers.length, 0);
});
