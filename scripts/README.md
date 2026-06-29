# scripts/ — 브리지 실행 · 자동 시작 · 전역 훅 설치

브리지를 띄우고(터널 없이도 가능), 로그인 시 자동 시작하게 하고, 모든 Claude Code 세션의
변경성 도구 호출을 텔레그램 승인으로 게이팅하는 스크립트 모음입니다.

> 안전 원칙: 전역을 바꾸는 스크립트는 **기본이 dry-run**이고, **백업 후 병합**하며, **되돌릴 수
> 있고**, 깜짝 전역 변경을 하지 않습니다. `--apply`(또는 PowerShell 등록 실행)는 **사용자가 직접**
> 실행하는 의도적 단계입니다.

---

## 1. 브리지만 실행 (터널 없음)

브리지는 항상 loopback(`127.0.0.1:4318`)에만 바인딩합니다. 폰에서 곧바로 닿게 하지 않고
로컬에서만 쓰거나(같은 PC의 세션), 아래 자동 시작/터널과 조합합니다.

```sh
node scripts/run-bridge.mjs          # 토큰 프리플라이트 + /v1/healthz 게이트
node scripts/health.mjs              # 한 번 헬스 체크 (exit 0 = 정상)
```

`bridge/.env`에 `BRIDGE_TOKEN`이 없으면 브리지는 부팅을 거부합니다(토큰 없는 게이트는 게이트가
아니므로). 터널까지 한 번에 띄우려면 `node scripts/up.mjs` (자세한 건 `deploy/README.md`).

---

## 2. 로그인 시 자동 시작 (Windows Scheduled Task)

브리지 프로세스를 로그인 때 자동으로 띄웁니다. **게이팅과 무관**하므로 단독으로는 안전합니다.

```powershell
# 등록 (현재 사용자 로그온 트리거, 실패 시 재시작 x3)
pwsh scripts/install-autostart.ps1

# 지금 바로 시작 (로그아웃 없이)
Start-ScheduledTask -TaskName 'claude-mobile-approver-bridge'

# 제거
pwsh scripts/uninstall-autostart.ps1
```

- 작업 이름: `claude-mobile-approver-bridge`
- 동작: `node "<repo>/scripts/run-bridge.mjs"` (작업 디렉터리 = repo 루트)
- 관리자 권한 불필요(현재 대화형 사용자로 실행). `node`가 PATH에 없으면
  `install-autostart.ps1`의 `$NodeExe`를 절대 경로로 수정하세요.
- `Register-ScheduledTask -Force`로 멱등 — 재실행하면 기존 정의를 교체합니다.

---

## 3. 전역 훅 설치 (모든 세션 게이팅) — 의도적 단계

`~/.claude/settings.json`에 훅을 병합해, **이 PC의 모든 Claude Code 세션**에서:

| 이벤트 | 매처 | 명령 | 동작 |
|---|---|---|---|
| `PreToolUse` | `Bash\|Edit\|Write\|MultiEdit\|NotebookEdit` | `hooks/approve.mjs` | 원격 승인 게이트 (fail-closed: 기본 거부) |
| `Notification` | (없음) | `hooks/notify.mjs Notification` | 이벤트 보고 (fail-open) |
| `PostToolUse` | (없음) | `hooks/notify.mjs PostToolUse` | 이벤트 보고 |
| `SubagentStop` | (없음) | `hooks/notify.mjs SubagentStop` | 이벤트 보고 |

각 항목 env에는 `BRIDGE_URL=http://127.0.0.1:4318`와, 설치 시점에 `bridge/.env`에서 읽은
`BRIDGE_TOKEN`이 절대 경로 명령과 함께 기록됩니다.

> ⚠️ 설치하면 **이 폴더에서 띄운 세션을 포함해** 모든 세션의
> Bash/Edit/Write/MultiEdit/NotebookEdit 호출이 매번 텔레그램 승인을 기다립니다. 브리지가 떠
> 있어야 하며(`scripts/run-bridge.mjs` 또는 자동 시작), 아니면 모든 변경성 호출이 기본 거부됩니다.

```sh
# 1) 먼저 dry-run — 무엇을 추가/변경할지 정확히 출력만 (아무것도 쓰지 않음)
node scripts/install-hooks-global.mjs

# 2) 확인했으면 적용 — 먼저 settings.json 백업 후 병합, 결과 JSON 검증
node scripts/install-hooks-global.mjs --apply
#    백업 접미사 지정 (기본 "manual"):
node scripts/install-hooks-global.mjs --apply --stamp 20260629

# 되돌리기 — 우리가 넣은 항목만 제거 (이것도 기본 dry-run)
node scripts/uninstall-hooks-global.mjs
node scripts/uninstall-hooks-global.mjs --apply
```

- **멱등**: 우리 명령은 절대 경로(`hooks/approve.mjs` / `hooks/notify.mjs`)로 식별하므로
  재실행해도 중복 추가되지 않습니다.
- **비파괴**: 기존 키와 우리 것이 아닌 훅은 그대로 둡니다. uninstall은 우리 항목만 제거합니다.
- `--apply` 시 `~/.claude/settings.json` → `settings.json.bak-<stamp>`로 백업한 뒤 씁니다
  (`Date.now()`가 아니라 고정/인자 접미사 — 결정적).

---

## 4. (선택) SessionStart 훅으로 브리지 자동 기동

`hooks/ensure-bridge.mjs`는 세션 시작 시 `~1s` 헬스 체크 후, 브리지가 죽어 있으면 best-effort로
detached 기동합니다. **세션 시작을 절대 막지 않고**(fail-open) 예외를 던지지 않으며, 헬스 체크가
실패했을 때만 띄워 중복 기동을 막습니다. 자동 시작 작업의 빈틈(미설치/크래시)을 메우는 보조 수단입니다.

`install-hooks-global.mjs`는 이 훅을 **자동으로 넣지 않습니다**(의도적). 쓰려면 직접
`~/.claude/settings.json`에 추가하세요:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [ { "type": "command",
                   "command": "node \"C:/Users/.../agent-mobile-bridge/hooks/ensure-bridge.mjs\"",
                   "env": { "BRIDGE_TOKEN": "<token>" } } ] }
  ]
}
```

---

## 권장 순서

1. `node scripts/install-hooks-global.mjs` 로 dry-run 검토
2. `pwsh scripts/install-autostart.ps1` (또는 `node scripts/run-bridge.mjs`)로 브리지 기동 보장
3. 브리지가 헬스 정상인지 확인 (`node scripts/health.mjs`)
4. `node scripts/install-hooks-global.mjs --apply` 로 게이팅 활성화
5. 되돌릴 때: `node scripts/uninstall-hooks-global.mjs --apply` → `pwsh scripts/uninstall-autostart.ps1`
