# NOVA VOICE — 음성 컴퓨터 제어 (Computer Use)

목표: "파인더 열고 xxx 찾아줘", "nova-use 실행해줘", "입력창에 포커스",
"표 그려줘", "이미지 그려줘 그리고 문서에 넣어줘" 를 말로 실행한다.

## 조사 결과 — 새로 만들 것과 이미 있는 것

실측(2026-08-05):

| 자산 | 상태 | 근거 |
|---|---|---|
| NOVA Use v0.0.86 | **OS 제어 엔진 이미 존재** | `@nut-tree-fork/nut-js@^4.2.6` 의존성 |
| NOVA Use 브리지 | **가동 중 :8791 (WebSocket)** | `agent-bridge-server.ts`, `lsof` LISTEN 확인 |
| 브리지 동작 | NAVIGATE / CLICK / MOUSE_CLICK / TYPE / SCROLL / SCREENSHOT / QUERY_DOM / CDP_EXECUTE / ANALYZE 등 | `agent-bridge-server.ts` 액션 분기 |
| NOVA Use MCP | `McpServer('nova-use-vault')` + 외부 커넥터 연결 | `src/main/mcp.ts` |
| NOVA-AX MCP 도구 21개 | 전부 **관리용** (health/agents/metrics) — 제어 도구 아님 | `resources/command-catalog.json` novaAxTools |
| NOVA VOICE 주입 | 클립보드 + Cmd+V, 슬래시 라우팅 205개 | `injector.ts`, `cli-command-router.ts` |
| 이미지 생성 | **어디에도 없음** | `gpt-image|dall-e|images/generations` grep 0건 |

**결론: 컴퓨터 제어를 NOVA VOICE 안에 다시 만들지 않는다.**
NOVA Use가 이미 엔진이고 브리지를 노출한다. NOVA VOICE는 *음성을 의도로
바꾸어 그 엔진에 보내는 쪽*이 된다. 중복 구현은 두 개의 제어 경로를 만들고
권한·안전 게이트를 두 번 관리하게 만든다.

새로 만들어야 하는 것은 세 가지뿐이다.
1. 음성 → 구조화된 의도(intent) 변환
2. 의도 → NOVA Use 브리지 호출 어댑터 (+ OS 네이티브 동작 일부)
3. 이미지 생성과 문서 삽입 (기존에 전무)

## 아키텍처

```
음성 → Whisper STT
     → 의도 분류기 (경량 로컬 모델 재사용: qwen3:4b)
        ├─ dictation  → 기존 경로 (그대로)
        ├─ meta       → 기존 경로 (그대로)
        └─ computer   → 새 경로
             → intent JSON {action, target, args}
             → 실행기
                ├─ OS 네이티브   (앱 실행/전환, Finder 검색, 포커스)
                ├─ NOVA Use 브리지 :8791 (브라우저·화면 제어)
                └─ 생성기        (이미지·표 → 문서 삽입)
```

의도 분류는 이미 붙어 있는 경량 모델(qwen3:4b, 웜 1.6초 실측)을 재사용한다.
새 모델을 얹지 않는다.

## 안전 설계 (선행 조건)

컴퓨터 제어는 되돌릴 수 없는 동작을 포함한다. 아래는 구현 전 확정한다.

- **허용 목록 방식**: 실행 가능한 action 을 열거하고, 목록 밖은 거부한다.
  자연어를 셸 명령으로 바꾸는 경로는 만들지 않는다.
- **파괴적 동작 확인**: 삭제·덮어쓰기·전송·앱 종료는 오버레이에서 명시적
  확인을 받는다. 확인 없이 실행하지 않는다.
- **경로 범위 제한**: 파일 접근은 홈 디렉터리 하위로 제한하고 심볼릭 링크를
  따라가지 않는다.
- **드라이런 로그**: 모든 실행을 `[ComputerUse]` 로 남긴다. 무엇을 왜
  실행했는지 사후에 확인할 수 있어야 한다.
- **취소**: 기존 `Ctrl+Escape` 취소가 실행 중 동작에도 걸리게 한다.

## 작업 분해 (병렬 가능 단위)

### T1. 의도 스키마 + 분류기  [선행]
- `src/shared/computer-intent.ts` — action 열거, Zod 유사 런타임 검증
- `src/main/intent-classifier.ts` — 경량 모델로 발화 → intent JSON
- 분류 실패 시 기존 받아쓰기로 폴백 (기능 후퇴 없음)
- 검증: 발화 20종 → intent 정확도, 허용 목록 밖 거부

### T2. OS 네이티브 실행기  [T1 이후]
- `src/main/computer-os.ts`
- 앱 실행/전환 (`open -b`, 기존 injector 패턴 재사용)
- Finder 열기 + 파일 검색 (`mdfind`, 홈 하위 제한)
- 입력창 포커스 (Accessibility, 기존 injector 가 이미 사용 중)
- 검증: 각 동작 실제 실행 후 상태 확인 (osascript 로 결과 조회)

### T3. NOVA Use 브리지 어댑터  [T1 이후, T2 와 병렬]
- `src/main/nova-use-bridge.ts`
- :8791 WebSocket 연결, 재연결, 브리지 미가동 시 명확한 실패
- CLICK / TYPE / SCREENSHOT / NAVIGATE 매핑
- 검증: 브리지에 실제 연결해 왕복 확인

### T4. 이미지 생성 + 문서 삽입  [T1 이후, T2·T3 과 병렬]
- `src/main/image-generation.ts` — OpenAI `gpt-image-1`
- 표 생성은 모델 없이 결정적으로 (마크다운/HTML)
- 결과를 클립보드 이미지로 넣고 기존 injector 로 문서에 삽입
- **API 키 필요** — 사용자 확인 필요 항목
- 검증: 실제 생성 → 파일 존재 + 이미지 헤더 확인 → 삽입 확인

### T5. 통합 + UI  [T2·T3·T4 이후]
- `ipc.ts` 라우팅에 computer 모드 추가
- 오버레이에 실행 중 동작·확인 프롬프트 표시
- 단축키: 기존 2개 유지, computer 모드는 의도 분류가 자동 판정
- 검증: 스크린샷 + 실제 왕복

## 미해결 — 사용자 확인 필요

1. **OpenAI API 키** — 이미지 생성에 필수. 보관 위치와 사용 승인.
2. **브리지 소유권** — :8791 을 현재 Python 프로세스가 점유 중이다.
   NOVA Use 브리지와 동일한 것인지 확인 필요.
3. **파괴적 동작 범위** — 어디까지 확인 없이 허용할지.
