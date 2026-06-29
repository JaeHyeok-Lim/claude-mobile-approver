// Tests for the safe-partial coercion + Korean card render helpers. The security claim under test:
// nothing the renderer produces can contain a raw command arg, flag value, or full path — only the
// safe tokens the hook's redact() was allowed to emit (prog + plain subcommand, basename, masked
// path, field names). maskPath must collapse the middle of a deep path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abstractKo,
  coerceSafeInput,
  koreanToolLabel,
  maskPath,
  safePartial
} from "./redact.js";

test("coerceSafeInput accepts the three valid shapes", () => {
  assert.deepEqual(coerceSafeInput({ kind: "bash", prog: "npm", sub: "install", argc: 7 }), {
    kind: "bash",
    prog: "npm",
    sub: "install",
    argc: 7
  });
  assert.deepEqual(
    coerceSafeInput({ kind: "file", basename: "config.ts", pathMasked: "C:\\…\\src\\config.ts" }),
    { kind: "file", basename: "config.ts", pathMasked: "C:\\…\\src\\config.ts" }
  );
  assert.deepEqual(coerceSafeInput({ kind: "other", fields: ["url", "prompt"], count: 2 }), {
    kind: "other",
    fields: ["url", "prompt"],
    count: 2
  });
});

test("coerceSafeInput is backward-tolerant: legacy/missing/garbage -> undefined", () => {
  // The old shape-map (field -> {type,len}) has no `kind` -> treated as legacy.
  assert.equal(coerceSafeInput({ command: { type: "string", len: 40 } }), undefined);
  assert.equal(coerceSafeInput(undefined), undefined);
  assert.equal(coerceSafeInput(null), undefined);
  assert.equal(coerceSafeInput("nope"), undefined);
  assert.equal(coerceSafeInput([1, 2, 3]), undefined);
  assert.equal(coerceSafeInput({ kind: "bash" }), undefined); // missing prog
});

test("maskPath collapses the middle of a deep path, keeps root + last 2 segments", () => {
  assert.equal(
    maskPath("C:\\Users\\alice\\projects\\agent-mobile-bridge\\bridge\\src\\config.ts"),
    "C:\\…\\src\\config.ts"
  );
  assert.equal(maskPath("/home/alice/work/secret-project/app/server.ts"), "/home/…/app/server.ts");
  // ≤3 segments shown as-is.
  assert.equal(maskPath("C:\\Users\\config.ts"), "C:\\Users\\config.ts");
  assert.equal(maskPath("/etc/hosts"), "/etc/hosts");
  // The middle dirs (which can leak project/user info) must NOT appear in a deep path.
  const masked = maskPath("/home/alice/super-secret/deep/tree/file.ts");
  assert.ok(!masked.includes("super-secret"));
  assert.ok(!masked.includes("alice"));
});

test("koreanToolLabel maps known tools, falls back for unknown", () => {
  assert.equal(koreanToolLabel("Bash"), "셸 명령 실행");
  assert.equal(koreanToolLabel("Edit"), "파일 수정");
  assert.equal(koreanToolLabel("Write"), "파일 생성·덮어쓰기");
  assert.equal(koreanToolLabel("Read"), "파일 읽기");
  assert.equal(koreanToolLabel("NotebookEdit"), "노트북 수정");
  assert.equal(koreanToolLabel("WebFetch"), "웹 요청");
  assert.equal(koreanToolLabel("Grep"), "파일 검색");
  assert.equal(koreanToolLabel("SomethingNew"), "SomethingNew 실행");
});

test("abstractKo + safePartial for bash carry ONLY prog + subcommand + token count", () => {
  const safe = coerceSafeInput({ kind: "bash", prog: "npm", sub: "install", argc: 7 });
  assert.equal(abstractKo("Bash", safe), "셸 명령 'npm install' 실행 (총 7개 토큰)");
  assert.equal(safePartial(safe), "명령: npm install …");
});

test("abstractKo + safePartial for file carry ONLY the basename", () => {
  const safe = coerceSafeInput({
    kind: "file",
    basename: "config.ts",
    pathMasked: "C:\\…\\src\\config.ts"
  });
  assert.equal(abstractKo("Edit", safe), "파일 수정: config.ts");
  assert.equal(safePartial(safe), "파일: config.ts");
});

test("abstractKo + safePartial for other carry ONLY field names", () => {
  const safe = coerceSafeInput({ kind: "other", fields: ["url", "prompt"], count: 2 });
  assert.equal(abstractKo("WebFetch", safe), "웹 요청 (필드 2개)");
  assert.equal(safePartial(safe), "필드: url, prompt");
});

test("missing safeInput -> abstract falls back to the tool label, no partial", () => {
  assert.equal(abstractKo("Bash", undefined), "셸 명령 실행");
  assert.equal(safePartial(undefined), "");
});
