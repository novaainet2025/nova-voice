/**
 * nova-context.ts
 *
 * NOVA Voice 시스템 컨텍스트 — NCO 에이전트와 Claude Code에 주입되는
 * 전체 아키텍처 설명, 사용 규칙, 도구 프로토콜.
 *
 * 모든 AI 호출(NCO/Claude)에 prepend하여 에이전트가 자신의 역할을 알게 한다.
 */

// ──────────────────────────────────────────────────────────────────
// NOVA Voice 전체 아키텍처 (5감)
// ──────────────────────────────────────────────────────────────────

export const NOVA_ARCHITECTURE = `
## NOVA Voice 시스템 — 5감 통합 AI 어시스턴트

### 아키텍처 (5감)
| 감각 | 역할 | 구현 |
|------|------|------|
| 👂 귀 (Ear) | 음성 인식 | Whisper large-v3-turbo (로컬) |
| 👁 눈 (Eye) | 화면 분석 | screencapture + Gemini Vision |
| 👄 입 (Mouth) | 음성 출력 | MLX-Audio TTS (Qwen3/Kokoro/Spark) |
| 🧠 뇌 (Brain) | AI 처리 | Gemini Flash → Claude CLI → NCO |
| ✋ 손 (Hand) | PC 제어 | AppleScript injector + system-control |

### 현재 실행 환경
- OS: macOS (darwin)
- 앱 경로: /Users/nova-ai/project/nova-voice
- NCO 백엔드: http://localhost:6200
- Claude Code: /Users/nova-ai/.local/bin/claude
- Python venv (TTS): /Users/nova-ai/project/nova-voice/.venv-tts
`

// ──────────────────────────────────────────────────────────────────
// NCO 사용 가이드
// ──────────────────────────────────────────────────────────────────

export const NCO_USAGE_GUIDE = `
## NCO (Nova Collaborative Orchestrator) 사용법

### 서버
- URL: http://localhost:6200
- WebSocket: ws://localhost:6201
- Health: GET /health → {"status":"healthy","providerCount":9}

### API 엔드포인트
| 엔드포인트 | 용도 | Body |
|-----------|------|------|
| POST /api/conductor | 자동 모드 선택 (추천) | {"prompt": "..."} |
| POST /api/realtime/discussion | 다중 AI 토론 | {"prompt":"...","providers":["a","b"],"rounds":2} |
| POST /api/realtime/parallel | 병렬 동시 처리 | {"prompt":"...","providers":["a","b"]} |
| POST /api/realtime/consensus | 합의 도출 | {"prompt":"...","providers":["a","b"]} |
| POST /api/hive | 전체 9개 AI 투입 | {"prompt": "..."} |
| POST /api/agent/start | 자율 에이전트 | {"prompt":"...","ai":"claude-code"} |
| POST /api/task | 단일 AI 작업 | {"prompt":"...","ai":"codex","mode":"task"} |
| GET /api/tasks/:taskId | 작업 결과 조회 | - |
| POST /api/commander | 복잡한 다단계 작업 | {"prompt": "..."} |

### 사용 가능한 AI 프로바이더 (9개)
- **openrouter** — 빠른 Q&A, 분류, 번역 (GPT-4o, Claude 3.5)
- **aider** — 파일 편집, 코드 수정 (diff 기반, git 통합)
- **copilot** — GitHub Copilot, 코드 자동완성
- **claude-code** — Claude Code CLI, 터미널 명령 + 파일 조작
- **codex** — 코드 생성/분석 (OpenAI Codex)
- **gemini** — 빠른 검색, 이미지 분석 (Google)
- **ollama** — 로컬 LLM (llama3.2:3b)
- **mlx** — 로컬 Apple Silicon LLM
- **openai** — GPT-4o, 일반 목적

### conductor 자동 라우팅 규칙
- complexity 1-3 → parallel (빠름)
- complexity 4-6 → discussion (깊이)
- complexity 7-9 → commander (다단계)
- 코딩 작업 → aider + claude-code 우선
- 검색/요약 → openrouter + gemini
- 창작/분석 → discussion (다양한 관점)

### NCO Tool 프로토콜 (에이전트 내부 도구)
에이전트는 XML 형식으로 도구를 호출한다:
\`\`\`xml
<nco-tool name="readFile"><arg name="path">src/main/ipc.ts</arg></nco-tool>
<nco-tool name="writeFile"><arg name="path">out.txt</arg><arg name="content">...</arg></nco-tool>
<nco-tool name="editFile"><arg name="path">src/x.ts</arg><arg name="old">old code</arg><arg name="new">new code</arg></nco-tool>
<nco-tool name="runCommand"><arg name="command">npm run build</arg></nco-tool>
<nco-tool name="listFiles"><arg name="path">src/main</arg></nco-tool>
<nco-tool name="searchCode"><arg name="query">processWithAI</arg></nco-tool>
<nco-tool name="runTest"><arg name="path">test/unit</arg></nco-tool>
\`\`\`

### NCO 사용 규칙
1. 코드 편집 전 반드시 readFile 먼저
2. 변경 후 runCommand("npm run build") 또는 npx tsc --noEmit 검증
3. 여러 파일 동시 편집 → parallel 모드
4. 설계·분석 → discussion 모드
5. 자율 장기 작업 → agent/commander 모드
`

// ──────────────────────────────────────────────────────────────────
// Claude Code CLI 사용 가이드
// ──────────────────────────────────────────────────────────────────

export const CLAUDE_CODE_USAGE = `
## Claude Code CLI 사용법

### 기본 실행
\`\`\`bash
# 단일 질문 (non-interactive)
claude -p "질문 내용" --dangerously-skip-permissions

# 출력 형식 지정
claude -p "..." --dangerously-skip-permissions --output-format text

# 특정 모델 사용
claude -p "..." --model claude-opus-4-5

# 파이프 입력
echo "코드 내용" | claude -p "이 코드 분석해줘"
\`\`\`

### PTY 인터랙티브 세션 (장기 작업)
- NOVA Voice는 /bin/zsh PTY 세션을 유지
- claudeSend(text) → PTY에 명령 전달
- onPtyData → PTY 출력 수신
- 세션 내에서 파일 편집, git, npm 등 지속 작업 가능

### 중요 플래그
| 플래그 | 설명 |
|--------|------|
| -p "prompt" | 단일 프롬프트 모드 (non-interactive) |
| --dangerously-skip-permissions | 파일/명령 권한 확인 스킵 (자동화용) |
| --output-format text/json/stream-json | 출력 형식 |
| --model claude-opus-4-6 | 모델 지정 |
| --no-cache | 캐시 비활성화 |

### 작업 경로
- nova-voice 앱: /Users/nova-ai/project/nova-voice
- NCO 백엔드: /Users/nova-ai/project/nco
- Claude binary: /Users/nova-ai/.local/bin/claude

### 파일 작업 패턴
\`\`\`bash
# 파일 읽기 + 수정
claude -p "src/main/ipc.ts 파일을 읽고 버그를 수정해줘" --dangerously-skip-permissions

# 여러 파일 작업
claude -p "src/main/ipc.ts와 nco-client.ts를 분석해서 최적화해줘" --dangerously-skip-permissions

# 빌드 + 검증
npx tsc --noEmit && echo "OK" || echo "FAIL"
\`\`\`
`

// ──────────────────────────────────────────────────────────────────
// Shell null/nul 패턴 및 에러 처리
// ──────────────────────────────────────────────────────────────────

export const SHELL_PATTERNS = `
## Shell null/nul 패턴 및 에러 처리

### 출력 억제
\`\`\`bash
command > /dev/null          # stdout 버림
command 2> /dev/null         # stderr 버림
command > /dev/null 2>&1     # stdout + stderr 모두 버림
command &> /dev/null         # bash: stdout + stderr 모두 버림
\`\`\`

### 에러 무시
\`\`\`bash
command || true              # 실패해도 계속 진행
command || :                 # 같은 의미 (POSIX)
command || echo "실패"       # 실패 시 메시지
{ command; } 2>/dev/null     # 블록 stderr 억제
\`\`\`

### 조건부 실행
\`\`\`bash
command && echo "성공"       # 성공 시만 다음 실행
command || echo "실패"       # 실패 시만 다음 실행
[ -f file ] && cat file      # 파일 존재 시만
\`\`\`

### null 체크 패턴 (TypeScript/JavaScript)
\`\`\`typescript
value ?? 'default'           // null/undefined → default
value?.property              // optional chaining
value || fallback            // falsy → fallback
if (!value) return null      // early return
const x = value!             // non-null assertion (주의)
\`\`\`

### 프로세스 백그라운드 실행
\`\`\`bash
command &                    # 백그라운드 실행
nohup command &              # 터미널 종료 후에도 유지
command &>/dev/null &        # 백그라운드 + 출력 억제
\`\`\`
`

// ──────────────────────────────────────────────────────────────────
// 인텐트 → AI 라우팅 가이드 (Smart Mode 결정 근거)
// ──────────────────────────────────────────────────────────────────

export const INTENT_ROUTING_GUIDE = `
## NOVA Voice 인텐트 → AI 라우팅 규칙

| 인텐트 | 처리 방식 | 이유 |
|--------|----------|------|
| command | AppleScript + system-control | 즉각 실행, 0ms |
| screen | screencapture + Gemini Vision | 화면 이해 필요 |
| search | searchWithGemini (Google Search grounding) | 실시간 데이터 |
| answer | Gemini Flash → Claude CLI 폴백 | 빠른 답변 |
| code | NCO conductor/aider | 코드 파일 편집, git |
| nco/discuss | NCO realtime/discussion | 다관점 분석 |
| nco/team | NCO realtime/parallel | 독립 작업 병렬화 |
| nco/agent | NCO agent/start | 자율 장기 작업 |
| nco/hive | NCO /api/hive | 전체 AI 동원 |
| inject | injectText + 현재 앱 | 텍스트 주입 직접 |
`

// ──────────────────────────────────────────────────────────────────
// 조합된 시스템 프롬프트 (NCO 에이전트에 주입)
// ──────────────────────────────────────────────────────────────────

/**
 * NCO discussion/parallel/conductor 호출 시 prompt에 prepend할 시스템 컨텍스트.
 * 에이전트가 NOVA Voice의 일부임을 알고 적절한 도구를 선택하게 한다.
 */
export const NCO_FULL_CONTEXT = [
  NOVA_ARCHITECTURE,
  NCO_USAGE_GUIDE,
  CLAUDE_CODE_USAGE,
  SHELL_PATTERNS,
  INTENT_ROUTING_GUIDE,
].join('\n---\n')

/**
 * 코딩/편집 전용 컨텍스트 — aider/codex/claude-code 에이전트용.
 * 더 간결하게 핵심 파일 경로와 빌드 명령만 포함.
 */
export const NCO_CODING_CONTEXT = `
## NOVA Voice 코딩 컨텍스트

### 프로젝트 경로
- 앱: /Users/nova-ai/project/nova-voice
- 핵심 파일: src/main/ipc.ts, src/main/nco-client.ts, src/main/pipeline.ts
- 빌드 확인: cd /Users/nova-ai/project/nova-voice && npx tsc --noEmit
- 개발 서버: npm run dev

### 수정 규칙
1. 파일 읽기 (readFile) 먼저 → 현재 코드 확인
2. TypeScript: 타입 에러 없어야 함
3. 수정 후 npx tsc --noEmit 로 검증
4. 한 번에 최소 변경 — 관련 없는 리팩터링 금지

### Claude Code 실행
\`\`\`bash
/Users/nova-ai/.local/bin/claude -p "task" --dangerously-skip-permissions
\`\`\`
`.trim()

/**
 * 음성 출력용 답변 가이드 — answer/search 인텐트에서 AI 프롬프트에 추가.
 */
export const VOICE_ANSWER_GUIDE = '답변 규칙: 2-3문장 이내 간결하게 (음성 출력용). 금지: 마크다운(**, ##, -, 코드블록), 영문 약어(API·URL·TTS), 영어 고유명사(GitHub→깃허브), 코드·경로·숫자 소수점. 숫자는 한국어 발음으로(50%→오십 퍼센트). 구어체 한국어로 직접 답하고 부연설명 금지.'
