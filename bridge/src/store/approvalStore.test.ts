// Adversarial unit tests for the store's default-deny invariants. These are the rules a
// reviewer/security will try to break: no path from expired/denied -> allow, expiry beats a
// racing allow, store miss is not an allow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "./approvalStore.js";

const make = (ttlMs = 1000) => new ApprovalStore({ ttlMs, retainMs: 60_000 });
const seed = () => ({ tool: "Bash", summary: "Bash · 1 field (command)", sessionId: "s1" });

test("create yields pending with a future expiry", () => {
  const store = make();
  const v = store.create(seed());
  assert.equal(v.status, "pending");
  assert.ok(new Date(v.expiresAt).getTime() > Date.now());
});

test("resolve allow then poll sees allow", () => {
  const store = make();
  const { requestId } = store.create(seed());
  const r = store.resolve(requestId, "allow");
  assert.equal(r.ok, true);
  assert.equal(store.get(requestId)?.status, "allow");
});

test("resolve deny then poll sees deny", () => {
  const store = make();
  const { requestId } = store.create(seed());
  assert.equal(store.resolve(requestId, "deny").ok, true);
  assert.equal(store.get(requestId)?.status, "deny");
});

test("a resolved request is immutable — a second resolve is rejected (no replay flip)", () => {
  const store = make();
  const { requestId } = store.create(seed());
  store.resolve(requestId, "deny");
  const replay = store.resolve(requestId, "allow");
  assert.equal(replay.ok, false);
  assert.equal(store.get(requestId)?.status, "deny"); // still denied
});

test("TTL expiry projects to 'expired' on read (default-deny)", () => {
  const store = make(0); // already expired by the time we read
  const { requestId } = store.create(seed());
  assert.equal(store.get(requestId)?.status, "expired");
});

test("expiry beats a racing allow — cannot resolve an expired request to allow", () => {
  const store = make(0);
  const { requestId } = store.create(seed());
  const r = store.resolve(requestId, "allow");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "expired");
  assert.equal(store.get(requestId)?.status, "expired"); // never allow
});

test("store miss is not an allow (unknown id -> undefined)", () => {
  const store = make();
  assert.equal(store.get("does-not-exist"), undefined);
  const r = store.resolve("does-not-exist", "allow");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "not_found");
});
