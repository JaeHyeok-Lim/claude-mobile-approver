# Telegram → Claude Code 세션 프롬프트 입력 (Channels)

> **상태: opt-in / 미적용** — 이 기능은 문서화만 된 상태다. 현재 자동구동(Phase 5) 세션 시작 스크립트에는
> 포함하지 않는다. 직접 켜고 싶을 때만 아래 절차를 따른다.

---

## 한 줄 요약

Claude Code의 **Channels** 기능을 이용하면 폰 텔레그램에서 메시지를 보내는 것만으로
실행 중인 Claude Code 세션에 프롬프트를 주입할 수 있다. Claude의 응답도 텔레그램으로 돌아온다.

---

## 우리 승인 봇과의 역할 분담

이 Channels 봇은 기존 approval 봇과 **독립적**이고 **상호보완적**이다. 둘을 동시에 사용한다.

| 구분 | 기존 approval 봇 (`bridge/` + 훅) | Channels 봇 (이 문서) |
|---|---|---|
| **방향** | 아웃바운드 — Claude Code → 폰 | 인바운드 — 폰 → Claude Code 세션 |
| **역할** | 민감 툴 호출을 폰으로 전달, ✅/❌ 승인·거부 | 폰에서 타이핑한 프롬프트를 세션에 입력 |
| **구현** | PreToolUse 훅 + bridge 서버 + Expo 앱 | Claude Code 네이티브 Channels (MCP 기반) |
| **봇 토큰** | 이미 설정된 approval 봇 토큰 | **별도 두 번째 봇** 토큰 필요 |
| **데이터 경로** | 훅 → bridge → Expo push | 텔레그램 → Anthropic Channels → 세션 |

> **보안 참고:** Channels를 통한 프롬프트는 **Anthropic 서버와 텔레그램을 경유**한다.
> 이 경로는 approval 봇의 redaction 처리와 별개다. 여기서 전달되는 것은 사용자가 직접 타이핑하는
> 프롬프트이며, Claude Code 세션에 명령으로 입력된다. 민감한 내용을 텔레그램 채팅으로 직접 타이핑하지 말 것.

---

## 사전 요구사항 체크리스트

아래를 순서대로 확인한다. 하나라도 빠지면 Channels가 동작하지 않는다.

- [ ] **Claude Code v2.1.80 이상** — `claude --version` 실행 후 출력 버전 확인.
  (`확인 필요`: 최소 버전은 공식 문서 기준; 이후 버전에서 변경될 수 있음.)
- [ ] **Bun 설치** — Channels는 내부적으로 Bun을 사용한다.
  설치: `curl -fsSL https://bun.sh/install | bash` (Linux/macOS) 또는
  `powershell -c "irm bun.sh/install.ps1 | iex"` (Windows). 공식 문서: https://bun.sh/docs/installation
- [ ] **claude.ai 계정 인증** — Channels는 Anthropic/claude.ai 계정 인증 필수.
  API 키 인증(`ANTHROPIC_API_KEY`)만으로는 동작하지 않는다. `claude login`으로 claude.ai 계정으로 로그인돼 있어야 한다.
- [ ] **(Team/Enterprise 플랜 전용) 관리자 Channels 활성화** — 개인(Max) 플랜은 자동 활성화.
  Team/Enterprise는 Anthropic 콘솔에서 관리자가 Channels를 켜야 한다. (`확인 필요`: 활성화 방법은 플랜마다 다를 수 있음.)

---

## 단계별 셋업

### 1단계 — @BotFather로 두 번째 텔레그램 봇 생성

> 기존 approval 봇 토큰은 건드리지 않는다. 새 봇을 따로 만든다.

1. 텔레그램에서 `@BotFather` → `/newbot`
2. 봇 이름과 username 입력 (예: `MyClaudeInput`, `my_claude_input_bot`)
3. BotFather가 발급한 **HTTP API 토큰**을 안전한 곳에 메모해 둔다.
   (절대 채팅·git에 노출하지 말 것 — 이 토큰이 세션 프롬프트 입력 권한이다.)

### 2단계 — Claude Code에 Telegram 플러그인 설치

```bash
claude plugin install telegram@claude-plugins-official
```

(`확인 필요`: 플러그인 식별자 `telegram@claude-plugins-official`는 공식 문서 기준이다.
Claude Code가 업데이트되면서 변경될 수 있으므로 설치 전 공식 채널 문서 확인 권장.
공식 Channels 문서: https://code.claude.com/docs/en/channels.md)

### 3단계 — 플러그인에 봇 토큰 및 대상 chat 설정

플러그인 설치 후 구성 단계에서 아래 두 가지를 입력하라는 프롬프트가 표시된다:

- **봇 토큰**: 1단계에서 BotFather가 발급한 토큰
- **허용 chat ID**: 프롬프트를 수신할 Telegram chat ID (개인 DM 권장; `@userinfobot`으로 확인 가능)

chat ID를 지정하면 해당 채팅에서 보내는 메시지만 세션에 입력된다. **1:1 봇(자기 자신만 접근) 구성을 강력히 권장.**
채팅을 그룹으로 열어두면 그룹 멤버 누구나 세션에 프롬프트를 보낼 수 있다.

(`확인 필요`: 설정 방법(인터랙티브 설정 vs 설정 파일)은 플러그인 버전에 따라 다를 수 있다.)

### 4단계 — Channels를 활성화해서 세션 실행

```bash
claude --channels plugin:telegram@claude-plugins-official
```

이 플래그 없이 `claude`를 실행하면 Telegram Channel은 비활성화된다. 기존 세션·훅에 영향 없음.

### 5단계 — 폰에서 프롬프트 전송

폰의 텔레그램에서 2단계에서 만든 봇에게 직접 메시지를 보내면 Claude Code 세션에 프롬프트로 입력된다.
Claude의 응답도 텔레그램 채팅으로 돌아온다. 양방향 통신이다.

---

## 승인 시스템과의 공존 (두 봇 동시 운용)

두 봇은 독립적으로 작동하므로 같이 써도 충돌이 없다.

```
폰 텔레그램
 ├─ [Channels 봇] ─── 타이핑한 프롬프트 ──────────────────→ Claude Code 세션 (입력)
 └─ [approval 봇] ←── 민감 툴 승인 요청 (Expo push) ──── bridge ← 훅 (PreToolUse)
                       ↑ ✅/❌ 탭 → bridge resolve → 훅이 permissionDecision 반환
```

- **입력**: Channels 봇으로 프롬프트를 보낸다.
- **승인**: 세션이 민감 툴(Bash/Edit/Write)을 호출하면 기존 approval 봇이 push 알림을 보내고,
  폰의 Expo 앱 또는 텔레그램 approval 봇 메시지에서 ✅/❌을 탭한다.
- 두 채널은 각자 독립된 봇 토큰을 쓰고, 경로도 다르다 — 하나가 끊겨도 다른 하나에 영향 없다.

---

## 보안 및 주의사항

| 항목 | 내용 |
|---|---|
| 데이터 경로 | 텔레그램 서버 → Anthropic Channels 서버 → Claude Code 세션. 종단 간 암호화 없음 |
| 입력 내용 | 직접 타이핑하는 프롬프트 전문이 전달됨. 비밀번호·토큰·키를 채팅으로 보내지 말 것 |
| 봇 토큰 | `.env`에만 보관, git 커밋 금지, 노출 시 BotFather에서 즉시 재발급(`/revoke`) |
| 접근 제한 | chat ID를 반드시 자기 자신의 DM으로 한정. 그룹 채팅은 사용하지 말 것 |
| Channels 비활성 시 | `--channels` 플래그 없으면 Channels 미사용 — 기존 세션/훅 동작에 영향 없음 |
| 플러그인 없이 `--channels` | 해당 플러그인이 설치되지 않은 채 `--channels`를 넘기면 세션 시작이 실패할 수 있음. 그래서 자동구동 스크립트에는 포함하지 않는다 |

---

## 현재 상태 및 적용 방침

- **opt-in** — 자동으로 켜지지 않는다. 이 문서를 읽고 사용자가 명시적으로 설정해야 한다.
- **Phase 5 자동구동 미포함** — `scripts/up.mjs` 등 기존 기동 스크립트는 `--channels` 플래그를 붙이지 않는다.
  플러그인 미설치 환경에서 `--channels`를 넘기면 세션이 깨질 수 있어 분리한다.
- **브랜치**: `feat/v2-input-autostart` — 향후 자동구동에 통합할 때 이 브랜치를 기준으로 한다.
- 기능이 안정화되어 자동구동에 포함하기로 결정한다면 `scripts/up.mjs`에 `--channels` 플래그 추가와
  플러그인 사전 설치 여부 체크를 함께 추가한다.

---

## 관련 문서

- 공식 Channels 문서: https://code.claude.com/docs/en/channels.md
- Bun 설치: https://bun.sh/docs/installation
- 이 프로젝트의 기존 승인 흐름: `docs/ARCHITECTURE.md`
- 운영 기동 방법: `docs/HANDOFF.md` (실기기 테스트 런북 섹션)
