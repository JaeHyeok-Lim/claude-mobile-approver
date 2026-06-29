// SECURITY-CRITICAL tests for the hook's redact()/maskPath() — the trust boundary. The hook holds
// the RAW tool_input (which may carry secrets in command args, flag values, or file contents) and
// must emit ONLY safe partials. These tests PROVE that secrets after the program/subcommand are
// dropped, and that file paths are masked. Run with: node --test hooks/approve.test.mjs
//
// Importing this file does NOT run the gate: approve.mjs guards main() behind an entry-point check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, maskPath } from './approve.mjs';

test('Bash: emits only program + plain subcommand + token count — secrets are DROPPED', () => {
  const cmd = 'curl https://api.example.com -H "Authorization: Bearer sk-SECRET123" -o out.json';
  const out = redact('Bash', { command: cmd });
  // Program token kept; second token is a URL (has ://) -> NOT a plain subcommand -> sub:null.
  // argc is a rough whitespace token count (the quoted header splits too) — not load-bearing.
  assert.deepEqual(out, { kind: 'bash', prog: 'curl', sub: null, argc: 8 });
  // The secret must appear NOWHERE in the emitted partial.
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('sk-SECRET123'), 'secret token leaked');
  assert.ok(!serialized.includes('Authorization'));
  assert.ok(!serialized.includes('api.example.com'));
});

test('Bash: a plain subcommand is kept, but later args (incl. secrets) are dropped', () => {
  const out = redact('Bash', {
    command: 'git push origin main --force https://user:p@ss@host/repo.git'
  });
  assert.equal(out.kind, 'bash');
  assert.equal(out.prog, 'git');
  assert.equal(out.sub, 'push'); // plain subcommand, kept
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('p@ss'), 'credential leaked');
  assert.ok(!serialized.includes('origin'), 'arg after subcommand leaked');
  assert.ok(!serialized.includes('host/repo'));
});

test('Bash: second token rejected as subcommand when it has =, :, /, quotes, or a leading -', () => {
  assert.equal(redact('Bash', { command: 'rm -rf /' }).sub, null); // -rf is a flag
  assert.equal(redact('Bash', { command: 'node ./script.js' }).sub, null); // has / and .
  assert.equal(redact('Bash', { command: 'echo a:b' }).sub, null); // a:b has :
  assert.equal(redact('Bash', { command: 'FOO=bar make build' }).sub, 'make'); // sub=make (prog gated below)
  assert.equal(redact('Bash', { command: 'npm install' }).sub, 'install'); // clean
});

test('Bash: prog gate — env-prefix / path / subshell / quoted progs are REDACTED, never leaked', () => {
  // env-var prefix carrying a secret as token #1
  const a = redact('Bash', { command: 'GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA git push' });
  assert.equal(a.prog, '(명령)', 'env-prefix prog must be redacted');
  assert.ok(!JSON.stringify(a).includes('ghp_'), 'token leaked via prog');
  // absolute/relative path program leaks the path otherwise
  const b = redact('Bash', { command: '/home/user/.private/secret-tool arg' });
  assert.equal(b.prog, '(명령)');
  assert.ok(!JSON.stringify(b).includes('.private'), 'path leaked via prog');
  // quoted value and subshell
  assert.equal(redact('Bash', { command: 'ENV="sk-leak" run' }).prog, '(명령)');
  assert.ok(!JSON.stringify(redact('Bash', { command: 'ENV="sk-leak" run' })).includes('sk-leak'));
  assert.equal(redact('Bash', { command: '$(cat /etc/passwd)' }).prog, '(명령)');
  // legitimate bare program names are kept
  assert.equal(redact('Bash', { command: 'npm publish --token sk-x' }).prog, 'npm');
  assert.equal(redact('Bash', { command: 'git status' }).prog, 'git');
  assert.equal(redact('Bash', { command: 'docker-compose up' }).prog, 'docker-compose');
});

test('Edit/Write/Read: emits only basename + masked path — file CONTENT is dropped', () => {
  const out = redact('Edit', {
    file_path: 'C:\\Users\\alice\\projects\\secret-app\\src\\config.ts',
    old_string: 'API_KEY = "sk-LEAKED-OLD"',
    new_string: 'API_KEY = "sk-LEAKED-NEW"'
  });
  assert.equal(out.kind, 'file');
  assert.equal(out.basename, 'config.ts');
  assert.equal(out.pathMasked, 'C:\\…\\src\\config.ts');
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('sk-LEAKED'), 'file content leaked');
  assert.ok(!serialized.includes('old_string'));
  // The middle dirs (project name) are collapsed.
  assert.ok(!serialized.includes('secret-app'), 'middle path segment leaked');
});

test('NotebookEdit: uses notebook_path; content dropped', () => {
  const out = redact('NotebookEdit', {
    notebook_path: '/home/u/work/proj/analysis.ipynb',
    new_source: 'print(SECRET)'
  });
  assert.deepEqual(out, {
    kind: 'file',
    basename: 'analysis.ipynb',
    pathMasked: '/home/…/proj/analysis.ipynb'
  });
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('other tools: field NAMES only, never values', () => {
  const out = redact('WebFetch', { url: 'https://secret.internal/path?token=abc', prompt: 'do X' });
  assert.equal(out.kind, 'other');
  assert.deepEqual(out.fields.sort(), ['prompt', 'url']);
  assert.equal(out.count, 2);
  assert.ok(!JSON.stringify(out).includes('secret.internal'));
  assert.ok(!JSON.stringify(out).includes('token=abc'));
});

test('redact never throws on weird input -> safe fallback', () => {
  assert.deepEqual(redact('Bash', null), { kind: 'other', fields: [], count: 0 });
  assert.deepEqual(redact('Bash', 'a string'), { kind: 'other', fields: [], count: 0 });
  assert.deepEqual(redact(undefined, undefined), { kind: 'other', fields: [], count: 0 });
});

test('maskPath collapses the middle, keeps root + last 2 segments', () => {
  assert.equal(
    maskPath('C:\\Users\\alice\\projects\\agent-mobile-bridge\\bridge\\src\\config.ts'),
    'C:\\…\\src\\config.ts'
  );
  assert.equal(maskPath('/home/alice/work/proj/app/server.ts'), '/home/…/app/server.ts');
  assert.equal(maskPath('C:\\Users\\config.ts'), 'C:\\Users\\config.ts'); // ≤3 segments as-is
  assert.equal(maskPath('/etc/hosts'), '/etc/hosts');
});
