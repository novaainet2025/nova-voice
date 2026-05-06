# NCO 토론 결과: 화면 인식 & 브라우저 제어

## 토론 세션: sess_0eaIXo7r-3CUsaZp
- **참가자**: Claude Code, Gemini, Codex (GPT-5.4)
- **승자**: Gemini (8.5/10 합의 점수)

---

## 핵심 문제
앱이 "눈이 없다" — 브라우저를 열 수는 있지만, 화면이 뭔지, 어디를 클릭해야 하는지, 어디에 입력해야 하는지 모른다.

## 토론에서 도출된 4가지 해결 전략

### 1. 화면 인식 (현재 상태 파악)

| 방법 | 장점 | 단점 | 추천 |
|------|------|------|------|
| **CDP (Chrome DevTools Protocol)** | DOM 완벽 파악, 빠름 | 디버깅 포트 필요 | **✅ 웹 최적** |
| **VLM (Vision Language Model)** | 범용, 앱 무관 | GPU 필요, 느림 | ❌ 무거움 |
| **Accessibility API** | OS 내장, 빠름 | 웹 DOM 한계 | ⚠️ 보조 |

### 2. UI 요소 위치 파악

| 방법 | 대상 | 정확도 | 추천 |
|------|------|--------|------|
| **DOM 좌표 추출 (CDP)** | 웹페이지 내부 | 100% | **✅ 페이지 내부** |
| **OS Accessibility API** | 주소창, 탭 등 | 높음 | **✅ 브라우저 UI** |
| **AI 이미지 분석 (OmniParser)** | 모든 앱 | 보통 | ⚠️ 범용 폴백 |

### 3. 텍스트 입력 & 클릭

| 방법 | 범위 | 추천 |
|------|------|------|
| **nut.js / RobotJS** | OS 전체 마우스/키보드 | **✅ 범용** |
| **CDP Input Domain** | 브라우저 내부 (백그라운드 가능) | **✅ 브라우저** |
| **OS Script (AppleScript/PowerShell)** | 키보드 숏컷 | ⚠️ 보조 |

### 4. 권장 아키텍처

```
음성 "네이버에서 날씨 검색해"
    │
    ▼
[VoiceType] Whisper 텍스트 변환
    │
    ▼
[Voice Command Parser] 의도 파싱
    │ → {action: "browser_search", target: "네이버", query: "날씨"}
    ▼
[Smart Executor] 실행 전략 선택
    │
    ├─ 방법 A: 키보드 단축키 (빠름, 간단)
    │   1. Cmd+L (주소창 포커스)
    │   2. 타이핑: "naver.com"
    │   3. Enter
    │   4. 검색창 포커스 (Tab 키 또는 Cmd+L)
    │   5. 타이핑: "날씨"
    │   6. Enter
    │
    ├─ 방법 B: CDP 연결 (정확함)
    │   1. Chrome 디버깅 포트에 연결
    │   2. Page.navigate("https://naver.com")
    │   3. DOM에서 검색 input 찾기
    │   4. Input.dispatchKeyEvent로 입력
    │   5. 검색 버튼 클릭
    │
    └─ 방법 C: URL 직접 구성 (가장 간단)
        1. open "https://search.naver.com/search?query=날씨"
```

---

## 실질적 구현 우선순위 (Gemini 제안)

### Phase 1: 키보드 단축키 기반 (즉시 구현 가능)
브라우저 주소창은 **Cmd+L** (macOS) / **Ctrl+L** (Windows)로 즉시 포커스 가능.
검색은 **URL 직접 구성**으로 해결.

```
"네이버 검색 날씨" →
  open "https://search.naver.com/search?query=날씨"

"유튜브에서 음악 검색" →
  open "https://youtube.com/results?search_query=음악"

"주소창에 github.com 입력" →
  Cmd+L → 타이핑 "github.com" → Enter
```

### Phase 2: CDP/Playwright 연결
- Chrome을 `--remote-debugging-port=9222`로 실행
- `puppeteer-core` 또는 `playwright-core`로 연결
- DOM 쿼리, 클릭, 입력을 정확하게 실행

### Phase 3: Multimodal AI (스크린 인식)
- 스크린 캡처 → VLM (LLaVA/GPT-4V) → 화면 이해
- "파란색 로그인 버튼 클릭해" → AI가 좌표 추출 → 클릭
- 가장 강력하지만 가장 무거운 방법

---

## 결론: Phase 1이 90%를 해결한다

대부분의 브라우저 작업은 **키보드 단축키 + URL 직접 구성**으로 해결 가능:
- `Cmd+L` → 주소창 포커스
- `Cmd+T` → 새 탭
- `Cmd+W` → 탭 닫기
- `Cmd+F` → 페이지 내 검색
- URL 직접 구성 → 검색 엔진별 쿼리 URL

이것만으로 "네이버에서 날씨 검색", "유튜브에서 뉴스 검색", "깃허브 열어" 등 90%의 사용 사례를 커버할 수 있다.
