# 음성 PC/앱 제어 연구 보고서

## 1. 결론 요약

**음성으로 PC와 앱을 제어하는 것은 충분히 가능하며, 현재 VoiceType 앱의 기술 스택으로 구현 가능합니다.**

### 실현 가능성: ✅ 높음

| 기능 | macOS | Windows | 구현 난이도 |
|------|-------|---------|------------|
| 앱 열기/닫기/전환 | AppleScript | PowerShell | 쉬움 |
| 볼륨/밝기 조절 | AppleScript | PowerShell/win-audio | 쉬움 |
| 창 관리 (최소화/최대화/타일) | AppleScript | PowerShell/win-control | 쉬움 |
| 브라우저 제어 (탭/URL) | AppleScript + open | PowerShell + start | 쉬움 |
| 키보드/마우스 시뮬레이션 | AppleScript | nut.js/PowerShell | 보통 |
| 파일/폴더 열기 | open/AppleScript | PowerShell/start | 쉬움 |
| 시스템 설정 변경 | AppleScript | PowerShell | 보통 |
| 스크린샷 | screencapture | PowerShell | 쉬움 |
| 잠금/절전/종료 | pmset/AppleScript | PowerShell | 쉬움 |
| 자연어 명령 파싱 | LLM (Ollama/NCO) | 동일 | 보통 |

---

## 2. 기술 구현 방법

### 2.1 macOS 제어 (AppleScript — 추가 의존성 없음)

모든 기능이 내장 `osascript` 명령으로 구현 가능합니다.

```typescript
// 앱 열기
execFile('open', ['-a', 'Google Chrome'])

// 앱 활성화
execFile('osascript', ['-e', 'tell application "Safari" to activate'])

// 앱 종료
execFile('osascript', ['-e', 'tell application "Safari" to quit'])

// 볼륨 조절 (0-100)
execFile('osascript', ['-e', 'set volume output volume 50'])

// 음소거
execFile('osascript', ['-e', 'set volume output muted true'])

// 창 최소화
execFile('osascript', ['-e',
  'tell application "System Events" to tell process "Safari" to set miniaturized of window 1 to true'])

// URL 열기
execFile('open', ['https://google.com'])

// 특정 브라우저에서 URL
execFile('open', ['-a', 'Google Chrome', 'https://example.com'])

// 키보드 단축키 시뮬레이션 (Cmd+T = 새 탭)
execFile('osascript', ['-e',
  'tell application "System Events" to keystroke "t" using command down'])

// 스크린샷
execFile('screencapture', ['-x', '/tmp/screenshot.png'])

// 알림 표시
execFile('osascript', ['-e',
  'display notification "작업 완료" with title "VoiceType"'])

// 잠금
execFile('osascript', ['-e',
  'tell application "System Events" to key code 12 using {control down, command down}'])

// 절전
execFile('pmset', ['sleepnow'])

// 폴더 열기
execFile('open', ['/Users/nova-ai/Downloads'])

// Finder에서 파일 보기
execFile('osascript', ['-e',
  'tell application "Finder" to reveal (POSIX file "/path/to/file")'])
```

### 2.2 Windows 제어 (PowerShell)

```typescript
// 앱 열기
execFile('powershell', ['-Command', 'Start-Process "chrome.exe"'])

// 앱 종료
execFile('powershell', ['-Command', 'Stop-Process -Name "chrome" -Force'])

// 볼륨 조절
execFile('powershell', ['-Command',
  '[Audio]::Volume = 0.5']) // nircmd 또는 SoundVolumeView 필요

// URL 열기
execFile('powershell', ['-Command', 'Start-Process "https://google.com"'])

// 잠금
execFile('powershell', ['-Command', 'rundll32.exe user32.dll, LockWorkStation'])

// 절전
execFile('powershell', ['-Command', 'Add-Type -Assembly System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false)'])
```

### 2.3 크로스 플랫폼 라이브러리

| 라이브러리 | 용도 | 추천 |
|-----------|------|------|
| `nut.js` | 키보드/마우스 자동화 | Windows 필요 시 |
| `node-window-manager` | 창 관리 | 크로스 플랫폼 필요 시 |
| `loudness` | 볼륨 제어 | 크로스 플랫폼 |
| `active-win` | 활성 윈도우 정보 | 유용 |

macOS는 AppleScript만으로 모든 것이 가능하므로 추가 의존성 불필요.

---

## 3. 음성 명령 파싱 아키텍처

### 3단계 하이브리드 접근

```
음성 입력 → Whisper 텍스트 변환
    │
    ▼
[Tier 1] 패턴 매칭 (Regex) — 95% 처리, <50ms
    │  "크롬 열어" → {action: "open_app", target: "Google Chrome"}
    │  "볼륨 올려" → {action: "volume_up", value: 10}
    │
    ▼ (매칭 실패 시)
[Tier 2] LLM 의도 파싱 (Ollama/NCO) — 1-3초
    │  "내일 회의 준비할 수 있게 캘린더 앱 좀 켜줘"
    │  → {action: "open_app", target: "Calendar"}
    │
    ▼
[Safety] 안전 검증
    │  위험한 명령? → 확인 다이얼로그
    │  안전한 명령? → 즉시 실행
    │
    ▼
실행 → 피드백 (알림/음성)
```

### 명령 카테고리

#### 안전한 명령 (즉시 실행)
- 앱 열기/전환/최소화/최대화
- URL 열기, 새 탭
- 볼륨/밝기 조절
- 스크린샷
- 복사/붙여넣기
- 검색

#### 위험한 명령 (확인 필요)
- 앱 종료, 탭 닫기
- 파일 삭제
- 시스템 종료/재시작/절전
- 휴지통 비우기

### 한국어 명령 패턴 예시

```typescript
const VOICE_COMMANDS = [
  // 앱 제어
  { pattern: /^(.+)\s*(열어|실행|켜|시작)/, action: 'open_app' },
  { pattern: /^(.+)\s*(닫아|종료|꺼)/, action: 'close_app', confirm: true },
  { pattern: /^(.+)\s*(으로|로)\s*전환/, action: 'switch_app' },

  // 볼륨
  { pattern: /볼륨\s*(올려|높여|크게|업)/, action: 'volume_up' },
  { pattern: /볼륨\s*(내려|낮춰|작게|다운)/, action: 'volume_down' },
  { pattern: /음소거|뮤트|소리\s*꺼/, action: 'mute' },

  // 창 관리
  { pattern: /최소화/, action: 'minimize' },
  { pattern: /최대화|전체\s*화면/, action: 'maximize' },
  { pattern: /왼쪽\s*분할|왼쪽\s*타일/, action: 'tile_left' },
  { pattern: /오른쪽\s*분할|오른쪽\s*타일/, action: 'tile_right' },

  // 브라우저
  { pattern: /새\s*탭/, action: 'new_tab' },
  { pattern: /뒤로\s*가/, action: 'browser_back' },
  { pattern: /새로\s*고침|리프레시/, action: 'refresh' },

  // 시스템
  { pattern: /스크린샷|캡처/, action: 'screenshot' },
  { pattern: /잠금|잠가/, action: 'lock_screen' },
  { pattern: /절전|슬립/, action: 'sleep', confirm: true },
  { pattern: /종료|셧다운/, action: 'shutdown', confirm: true },

  // 파일
  { pattern: /다운로드\s*폴더/, action: 'open_downloads' },
  { pattern: /(.+)\s*검색/, action: 'search' },
]
```

---

## 4. 기존 프로젝트 참조

| 프로젝트 | 플랫폼 | 특징 |
|---------|--------|------|
| **Talon Voice** | Mac/Win/Linux | 가장 성숙한 음성 제어, Python API, 개발자 커뮤니티 |
| **OpenVoiceOS** | Linux | 오픈소스 음성 어시스턴트, 플러그인 아키텍처 |
| **EasySpeak** | Linux (2026) | 최신 로컬 음성 제어, Wayland 지원 |
| **VoiceBox** | Electron | Electron 기반 음성 제어 앱 |
| **Alan AI** | Electron SDK | 상용 음성 AI SDK |

---

## 5. 권장 구현 계획

### Phase 1: 기본 PC 제어 (2-3일)
- 명령 레지스트리 (패턴 매칭)
- 앱 열기/닫기/전환 (AppleScript)
- 볼륨/밝기 제어
- 시스템 명령 (잠금/스크린샷)
- 안전 확인 다이얼로그

### Phase 2: 고급 제어 (1주)
- LLM 의도 파싱 (Ollama 폴백)
- 브라우저 제어 (탭, URL, 검색)
- 창 관리 (타일, 리사이즈)
- 파일/폴더 탐색
- 음성 피드백 (TTS)

### Phase 3: 스마트 제어 (2주)
- 커스텀 명령 등록 UI
- 명령 히스토리/추천
- 앱별 맥락 인식
- 다단계 명령 체인
- Windows PowerShell 지원

---

## 6. 기술적 제약 및 주의사항

### 권한
- **macOS**: AppleScript로 System Events 제어 시 접근성 권한 필요 (최초 1회)
- **Windows**: 관리자 권한 필요한 명령은 UAC 프롬프트 발생
- **앱 제어**: 샌드박스 앱은 제어에 제한이 있을 수 있음

### 보안
- 음성 명령은 절대 임의 셸 명령을 실행하면 안 됨
- 화이트리스트 방식으로 허용된 명령만 실행
- 위험한 명령은 항상 시각적 확인 필요
- 모든 명령 실행을 감사 로그에 기록

### 성능
- 패턴 매칭: <50ms (즉시)
- LLM 파싱 (Ollama 3B): 1-3초
- LLM 파싱 (NCO/Claude): 2-5초
- 총 음성→실행: 5초 이내 목표
