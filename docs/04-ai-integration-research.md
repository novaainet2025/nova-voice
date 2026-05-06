# AI 기능 연동 연구 보고서

## 1. 사용 가능한 AI 인터페이스

### 1.1 NCO (Neural Command Orchestrator) — 최우선 추천
- **포트**: `http://localhost:6200` (REST API), `ws://localhost:6201` (WebSocket)
- **기능**: 9개 AI 프로바이더를 통합 관리하는 오케스트레이터
- **장점**: 하나의 API로 Claude, Gemini, Ollama, Codex, Aider 등 모든 AI에 접근 가능

#### 주요 REST API 엔드포인트
| 엔드포인트 | 메서드 | 기능 |
|-----------|--------|------|
| `/api/task` | POST | 단일 AI에 작업 위임 |
| `/api/conductor` | POST | 스마트 라우터 (복잡도 분석 → 최적 AI 자동 선택) |
| `/api/realtime/discussion` | POST | 멀티 AI 토론 |
| `/api/realtime/parallel` | POST | 병렬 작업 실행 |
| `/api/hive` | POST | 전체 9개 AI 동시 실행 |
| `/api/chat/messages` | POST | 채팅 메시지 |
| `/api/events/stream` | GET | SSE 실시간 이벤트 스트림 |
| `/health` | GET | 헬스 체크 |
| `/api/ai-providers` | GET | 프로바이더 목록/상태 |

#### 요청 예시
```json
POST http://localhost:6200/api/task
{
  "prompt": "이 텍스트를 비즈니스 이메일 형식으로 변환해주세요: ...",
  "ai": "claude-code",
  "mode": "task"
}
```

#### WebSocket 실시간 스트리밍
- 포트: `ws://localhost:6201`
- 프로토콜: MessagePack 바이너리 + JSON Patch (RFC 6902)
- 용도: 실시간 트랜스크립션 결과 AI 처리 스트리밍

### 1.2 개별 CLI 도구

#### Claude Code CLI
- **바이너리**: `/Users/nova-ai/.local/bin/claude`
- **프로그래밍 호출**: `claude -p --output-format json "프롬프트"`
- **출력 형식**: text, json, stream-json
- **응답 JSON**: `{ "result": "...", "total_cost_usd": 0.126 }`

#### Gemini CLI
- **바이너리**: `/opt/homebrew/bin/gemini`
- **프로그래밍 호출**: `gemini -p "프롬프트"` 또는 `-o json`
- **출력 형식**: text, json, stream-json

#### Ollama (로컬 LLM)
- **REST API**: `http://localhost:11434`
- **모델**: llama3.2:3b (설치됨), gemma4:26b (RTX 4090)
- **호출**: `POST /api/generate` 또는 `POST /api/chat`
- **장점**: 완전 오프라인, 무료, 빠른 응답

#### Codex CLI (OpenAI)
- **바이너리**: `/opt/homebrew/bin/codex`
- **참고**: 인터랙티브 모드 중심, 프로그래밍 호출에는 비적합

### 1.3 NCO AI 프로바이더 목록 (9개)
| ID | 이름 | 타입 | 점수 | 모델 | 비용 |
|----|------|------|------|------|------|
| claude-code | Claude Code | CLI | 95 | claude-opus-4-6 | 유료 |
| opencode | OpenCode | CLI | 90 | multi-llm | 유료 |
| gemini | Gemini CLI | CLI | 85 | gemini-2.5-pro | 유료 |
| codex | Codex | CLI | 83 | codex | 유료 |
| aider | Aider | CLI | 82 | llama-4-maverick | 무료 |
| ollama | Ollama | API | 80 | gemma4:26b | 무료 |
| cursor-agent | Cursor | CLI | 78 | cursor | 유료 |
| copilot | Copilot | CLI | 75 | claude-haiku-4.5 | 유료 |
| openrouter | OpenRouter | API | 75 | nemotron-3-super | 무료 |

---

## 2. VoiceType AI 통합 설계

### 2.1 아키텍처: NCO 연동

```
┌──────────────────────────────────────┐
│         VoiceType (Electron)          │
│                                      │
│  음성 → Whisper → 텍스트             │
│           │                          │
│           ▼                          │
│  ┌─────────────────┐                 │
│  │  AI Mode 선택    │                 │
│  │  ├ Direct (그대로)│                │
│  │  ├ Rewrite (교정) │               │
│  │  ├ Email (이메일)  │              │
│  │  ├ Code (코드)     │             │
│  │  └ Custom (커스텀) │             │
│  └────────┬────────┘                 │
│           │                          │
│           ▼                          │
│  ┌─────────────────┐                 │
│  │  NCO Client      │                │
│  │  POST :6200/api  │                │
│  └────────┬────────┘                 │
└───────────┼──────────────────────────┘
            │ HTTP/WebSocket
            ▼
┌──────────────────────────────────────┐
│         NCO Backend (:6200)           │
│  Smart Router → 최적 AI 선택          │
│  ├ Claude Code (높은 정확도)          │
│  ├ Gemini (빠른 응답)                 │
│  ├ Ollama (오프라인/무료)             │
│  └ OpenRouter (무료 대안)             │
└──────────────────────────────────────┘
```

### 2.2 AI 모드 정의

| 모드 | 설명 | AI 프롬프트 |
|------|------|------------|
| Direct | 음성 그대로 텍스트 출력 | (AI 없음) |
| Rewrite | 문법/맞춤법 교정 | "다음 텍스트의 문법과 맞춤법을 교정하세요: ..." |
| Email | 비즈니스 이메일 변환 | "다음 내용을 비즈니스 이메일 형식으로 작성하세요: ..." |
| Summarize | 요약 | "다음 내용을 간결하게 요약하세요: ..." |
| Translate | 번역 | "다음을 영어로 번역하세요: ..." |
| Code | 코드 생성 | "다음 설명에 맞는 코드를 작성하세요: ..." |
| Custom | 사용자 정의 프롬프트 | 사용자 입력 프롬프트 |

### 2.3 구현 우선순위

**Phase 1 (MVP AI):**
- NCO REST API 클라이언트 모듈 추가
- "Rewrite" 모드 (문법 교정) 구현
- Ollama 직접 연결 (오프라인 폴백)

**Phase 2:**
- 전체 AI 모드 시스템
- NCO 스마트 라우터 (자동 AI 선택)
- WebSocket 실시간 스트리밍
- 모드별 프롬프트 커스터마이즈 UI

**Phase 3:**
- 멀티 AI 토론 모드 (NCO discussion)
- 커스텀 프롬프트 에디터
- AI 모델 선택 UI
- 사용량/비용 추적

---

## 3. NCO 연결 방법

### 3.1 Node.js에서 NCO API 호출
```typescript
// 단일 작업 위임
const response = await fetch('http://localhost:6200/api/task', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: '다음 텍스트를 교정하세요: ' + transcribedText,
    ai: 'claude-code',  // 또는 'ollama' (무료), 'gemini'
    mode: 'task'
  })
});
const result = await response.json();
// result.taskId → 비동기 결과 폴링 또는 SSE/WebSocket
```

### 3.2 스마트 라우터 (자동 AI 선택)
```typescript
const response = await fetch('http://localhost:6200/api/conductor', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: '다음 텍스트를 비즈니스 이메일로 변환: ' + text
  })
});
// NCO가 프롬프트를 분석하여 최적 AI + 모드를 자동 선택
```

### 3.3 직접 Ollama 호출 (오프라인 폴백)
```typescript
const response = await fetch('http://localhost:11434/api/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'llama3.2:3b',
    prompt: '교정: ' + text,
    stream: false
  })
});
const result = await response.json();
// result.response → 처리된 텍스트
```

### 3.4 직접 Claude CLI 호출
```typescript
import { execFile } from 'child_process';
execFile('claude', ['-p', '--output-format', 'json', prompt], (err, stdout) => {
  const result = JSON.parse(stdout);
  // result.result → AI 응답 텍스트
});
```
