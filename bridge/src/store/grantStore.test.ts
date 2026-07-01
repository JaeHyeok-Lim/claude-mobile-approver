// Security-path tests for GrantStore: coverage authorizes ONLY within an active grant's scope,
// consumes a bounded op budget, binds to cwd/session, and honors expiry + terminal immutability.
// A bug here auto-authorizes work — so these assert the default-DENY edges hard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GrantStore, normPath } from "./grantStore.js";

const CWD = "C:/proj/App";
const FILE = "C:/proj/App/src/a.ts";

function store(over: Partial<{ ttlMs: number; retainMs: number; grantTtlMs: number }> = {}) {
  return new GrantStore({ ttlMs: 60_000, retainMs: 60_000, grantTtlMs: 600_000, ...over });
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    cwd: CWD,
    title: "t",
    items: ["do a thing"],
    files: [FILE],
    dirs: [] as string[],
    bash: false,
    maxOps: 3,
    ...over
  } as Parameters<GrantStore["create"]>[0];
}

test("pending grant covers nothing until approved", () => {
  const s = store();
  s.create(baseInput());
  assert.equal(s.cover({ cwd: CWD, tool: "Edit", path: FILE }).covered, false);
});

test("approved grant covers a listed file and consumes ops", () => {
  const s = store();
  const v = s.create(baseInput({ maxOps: 2 }));
  assert.ok(s.resolve(v.batchId, "allow").ok);
  const r1 = s.cover({ cwd: CWD, tool: "Edit", path: FILE });
  assert.equal(r1.covered, true);
  assert.equal(r1.remainingOps, 1);
  const r2 = s.cover({ cwd: CWD, tool: "Write", path: FILE });
  assert.equal(r2.covered, true);
  assert.equal(r2.remainingOps, 0);
  // Budget exhausted -> deny.
  assert.equal(s.cover({ cwd: CWD, tool: "Edit", path: FILE }).covered, false);
});

test("file outside scope is not covered", () => {
  const s = store();
  const v = s.create(baseInput());
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover({ cwd: CWD, tool: "Edit", path: "C:/proj/App/other.ts" }).covered, false);
});

test("dir prefix covers files under it, but not a sibling prefix", () => {
  const s = store();
  const v = s.create(baseInput({ files: [], dirs: ["C:/proj/App/src"] }));
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover({ cwd: CWD, tool: "Edit", path: "C:/proj/App/src/deep/x.ts" }).covered, true);
  // "src2" must NOT be matched by the "src" prefix (boundary check).
  assert.equal(s.cover({ cwd: CWD, tool: "Edit", path: "C:/proj/App/src2/x.ts" }).covered, false);
});

test("bash covered only when the batch allows bash", () => {
  const s = store();
  const noBash = s.create(baseInput());
  s.resolve(noBash.batchId, "allow");
  assert.equal(s.cover({ cwd: CWD, tool: "Bash" }).covered, false);

  const s2 = store();
  const yesBash = s2.create(baseInput({ bash: true }));
  s2.resolve(yesBash.batchId, "allow");
  assert.equal(s2.cover({ cwd: CWD, tool: "Bash" }).covered, true);
});

test("cwd mismatch is never covered", () => {
  const s = store();
  const v = s.create(baseInput());
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover({ cwd: "C:/proj/Other", tool: "Edit", path: FILE }).covered, false);
});

test("session-bound grant only covers its session; cwd-only grant covers any session in cwd", () => {
  const s = store();
  const bound = s.create(baseInput({ sessionId: "sess-1" }));
  s.resolve(bound.batchId, "allow");
  assert.equal(s.cover({ cwd: CWD, sessionId: "sess-2", tool: "Edit", path: FILE }).covered, false);
  assert.equal(s.cover({ cwd: CWD, sessionId: "sess-1", tool: "Edit", path: FILE }).covered, true);

  const s2 = store();
  const unbound = s2.create(baseInput()); // no sessionId
  s2.resolve(unbound.batchId, "allow");
  assert.equal(s2.cover({ cwd: CWD, sessionId: "whatever", tool: "Edit", path: FILE }).covered, true);
});

test("denied grant covers nothing", () => {
  const s = store();
  const v = s.create(baseInput());
  s.resolve(v.batchId, "deny");
  assert.equal(s.cover({ cwd: CWD, tool: "Edit", path: FILE }).covered, false);
});

test("grant window expiry: an approved grant stops covering after grantTtl", () => {
  const s = store({ grantTtlMs: 0 }); // window closes immediately
  const v = s.create(baseInput());
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover({ cwd: CWD, tool: "Edit", path: FILE }).covered, false);
  assert.equal(s.get(v.batchId)?.status, "expired");
});

test("expiry beats a racing allow (pending TTL lapsed)", () => {
  const s = store({ ttlMs: 0 });
  const v = s.create(baseInput());
  const r = s.resolve(v.batchId, "allow");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "expired");
});

test("terminal states are immutable (no double-resolve)", () => {
  const s = store();
  const v = s.create(baseInput());
  assert.ok(s.resolve(v.batchId, "deny").ok);
  const again = s.resolve(v.batchId, "allow");
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, "already_resolved");
  assert.equal(s.cover({ cwd: CWD, tool: "Edit", path: FILE }).covered, false);
});

test("unknown tool and file-tool-without-path fail closed", () => {
  const s = store();
  const v = s.create(baseInput({ bash: true }));
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover({ cwd: CWD, tool: "WebFetch", path: FILE }).covered, false);
  assert.equal(s.cover({ cwd: CWD, tool: "Edit" }).covered, false);
});

test("path matching is normalized (backslashes + case)", () => {
  const s = store();
  const v = s.create(baseInput({ files: ["C:/proj/App/src/A.ts"] }));
  s.resolve(v.batchId, "allow");
  // Windows-style backslashes + different case must still match.
  assert.equal(
    s.cover({ cwd: "C:\\proj\\App", tool: "Edit", path: "C:\\proj\\App\\src\\a.TS" }).covered,
    true
  );
});

test("normPath collapses separators, trailing slash, case", () => {
  assert.equal(normPath("C:\\Proj\\App\\"), "c:/proj/app");
  assert.equal(normPath("/a/b/"), "/a/b");
});

test("normPath resolves . and .. so traversal can't fake a prefix", () => {
  assert.equal(normPath("C:/proj/App/src/../../secret.ts"), "c:/proj/secret.ts");
  assert.equal(normPath("C:/a/./b/./c"), "c:/a/b/c");
  // Never pops past the drive root.
  assert.equal(normPath("C:/../../x"), "c:/x");
});

test("SECURITY: a .. traversal path is NOT covered by a dir grant (scope escape blocked)", () => {
  const s = store();
  const v = s.create(baseInput({ files: [], dirs: ["C:/proj/App/src"] }));
  s.resolve(v.batchId, "allow");
  // Textually starts with the covered dir, but escapes it via .. -> must be denied.
  const escape = "C:/proj/App/src/../../../Windows/System32/evil.dll";
  assert.equal(s.cover({ cwd: CWD, tool: "Write", path: escape }).covered, false);
});
