// Security-path tests for GrantStore: coverage authorizes ONLY within an active grant's scope,
// consumes a bounded op budget, is SESSION-bound, matches bash by allowed prefix, and honors
// expiry + terminal immutability. A bug here auto-authorizes work — so these hit the default-DENY
// edges hard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GrantStore, normPath } from "./grantStore.js";

const CWD = "C:/proj/App";
const FILE = "C:/proj/App/src/a.ts";
const SID = "sess-1";

function store(over: Partial<{ ttlMs: number; retainMs: number; grantTtlMs: number }> = {}) {
  return new GrantStore({ ttlMs: 60_000, retainMs: 60_000, grantTtlMs: 600_000, ...over });
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    cwd: CWD,
    sessionId: SID,
    title: "t",
    items: ["do a thing"],
    files: [FILE],
    dirs: [] as string[],
    bashAllow: [] as string[],
    maxOps: 3,
    ...over
  } as Parameters<GrantStore["create"]>[0];
}

// Coverage query defaulting to the matching session (tests override to probe binding).
function q(over: Record<string, unknown> = {}) {
  return { cwd: CWD, sessionId: SID, tool: "Edit", path: FILE, ...over } as Parameters<
    GrantStore["cover"]
  >[0];
}

test("pending grant covers nothing until approved", () => {
  const s = store();
  s.create(baseInput());
  assert.equal(s.cover(q()).covered, false);
});

test("approved grant covers a listed file and consumes ops", () => {
  const s = store();
  const v = s.create(baseInput({ maxOps: 2 }));
  assert.ok(s.resolve(v.batchId, "allow").ok);
  const r1 = s.cover(q({ tool: "Edit" }));
  assert.equal(r1.covered, true);
  assert.equal(r1.remainingOps, 1);
  const r2 = s.cover(q({ tool: "Write" }));
  assert.equal(r2.covered, true);
  assert.equal(r2.remainingOps, 0);
  assert.equal(s.cover(q()).covered, false); // budget exhausted
});

test("file outside scope is not covered", () => {
  const s = store();
  const v = s.create(baseInput());
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover(q({ path: "C:/proj/App/other.ts" })).covered, false);
});

test("dir prefix covers files under it, but not a sibling prefix", () => {
  const s = store();
  const v = s.create(baseInput({ files: [], dirs: ["C:/proj/App/src"] }));
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover(q({ path: "C:/proj/App/src/deep/x.ts" })).covered, true);
  assert.equal(s.cover(q({ path: "C:/proj/App/src2/x.ts" })).covered, false);
});

test("bash is covered only by a matching allowed prefix (boundary-safe)", () => {
  const s = store();
  const v = s.create(baseInput({ files: [], bashAllow: ["git push", "npm install"] }));
  s.resolve(v.batchId, "allow");
  // exact + extension of an allowed prefix
  assert.equal(s.cover(q({ tool: "Bash", path: undefined, prog: "git", sub: "push" })).covered, true);
  // an allowed prefix that IS the whole command
  assert.equal(s.cover(q({ tool: "Bash", path: undefined, prog: "npm", sub: "install" })).covered, true);
  // a DIFFERENT git subcommand is NOT covered
  assert.equal(s.cover(q({ tool: "Bash", path: undefined, prog: "git", sub: "reset" })).covered, false);
  // no bashAllow at all -> no bash covered
  const s2 = store();
  const v2 = s2.create(baseInput());
  s2.resolve(v2.batchId, "allow");
  assert.equal(s2.cover(q({ tool: "Bash", path: undefined, prog: "git", sub: "push" })).covered, false);
});

test("SESSION binding is required: wrong / missing session is never covered", () => {
  const s = store();
  const v = s.create(baseInput()); // sessionId SID
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover(q({ sessionId: "other" })).covered, false, "wrong session");
  assert.equal(s.cover(q({ sessionId: undefined })).covered, false, "missing session");
  assert.equal(s.cover(q()).covered, true, "matching session");
});

test("cwd mismatch is never covered (secondary guard)", () => {
  const s = store();
  const v = s.create(baseInput());
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover(q({ cwd: "C:/proj/Other" })).covered, false);
});

test("denied grant covers nothing", () => {
  const s = store();
  const v = s.create(baseInput());
  s.resolve(v.batchId, "deny");
  assert.equal(s.cover(q()).covered, false);
});

test("grant window expiry: an approved grant stops covering after grantTtl", () => {
  const s = store({ grantTtlMs: 0 });
  const v = s.create(baseInput());
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover(q()).covered, false);
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
  assert.equal(s.cover(q()).covered, false);
});

test("unknown tool and file-tool-without-path fail closed", () => {
  const s = store();
  const v = s.create(baseInput({ bashAllow: ["git"] }));
  s.resolve(v.batchId, "allow");
  assert.equal(s.cover(q({ tool: "WebFetch" })).covered, false);
  assert.equal(s.cover(q({ tool: "Edit", path: undefined })).covered, false);
});

test("path matching is normalized (backslashes + case)", () => {
  const s = store();
  const v = s.create(baseInput({ files: ["C:/proj/App/src/A.ts"] }));
  s.resolve(v.batchId, "allow");
  assert.equal(
    s.cover(q({ cwd: "C:\\proj\\App", path: "C:\\proj\\App\\src\\a.TS" })).covered,
    true
  );
});

test("normPath resolves . and .. so traversal can't fake a prefix", () => {
  assert.equal(normPath("C:/proj/App/src/../../secret.ts"), "c:/proj/secret.ts");
  assert.equal(normPath("C:/a/./b/./c"), "c:/a/b/c");
  assert.equal(normPath("C:/../../x"), "c:/x");
  assert.equal(normPath("C:\\Proj\\App\\"), "c:/proj/app");
});

test("SECURITY: a .. traversal path is NOT covered by a dir grant (scope escape blocked)", () => {
  const s = store();
  const v = s.create(baseInput({ files: [], dirs: ["C:/proj/App/src"] }));
  s.resolve(v.batchId, "allow");
  const escape = "C:/proj/App/src/../../../Windows/System32/evil.dll";
  assert.equal(s.cover(q({ tool: "Write", path: escape })).covered, false);
});
