# NOVA VOICE Provider Slash-Command Catalog & Meta-Mode Routing Review

**Status:** Read-only architectural analysis  
**Date:** 2026-08-05  
**Scope:** Command catalog, meta-mode routing, safety gates, matching priorities

---

## 1. Data Schema Architecture

### 1.1 Command Catalog Entry (`CommandCatalogEntry`)
```typescript
interface CommandCatalogEntry {
  command: string          // e.g. "/nco-discussion"
  provider: string         // e.g. "codex", "claude-code", "nco-source"
  domain: string          // e.g. "nco", "inter-session", "provider"
  description: string     // User-facing description (Korean)
  usage: string          // Format: "/command [args...]"
  aliases: string[]      // Alternative names/variations (max 12)
  kind: 'slash-command'
  source: string         // Source file path for traceability
}
```

**Constraints:**
- Command pattern: `/[A-Za-z0-9가-힣][A-Za-z0-9가-힣:_-]{0,80}` (83 chars max)
- Field length cap: 500 chars
- Max entries: 2,000
- Schema version: 1 (immutable for backward compat)

### 1.2 Meta Command Candidate (`MetaCommandCandidate`)
```typescript
interface MetaCommandCandidate {
  command: string         // Matched command (gated for output)
  usage: string          // Safe template for instruction injection
  description: string    // Reason for user understanding
  providers: string[]    // All providers offering this command
  reason: string         // Why matched (for transparency)
}
```

**Matching Purpose:** Bridge between user intent (speech) and allowed commands

### 1.3 Meta Tool Candidate (`MetaToolCandidate`)
```typescript
interface MetaToolCandidate {
  name: string          // e.g. "ax_health", "ax_dashboard"
  description: string   // What the tool does
  reason: string        // Why suggested
}
```

**Pattern:** `ax_[a-z0-9_]{1,80}` (MCP tool namespace, read-only in meta mode)

### 1.4 NOVA-AX Tool Entry (`NovaAxToolEntry`)
- Max tools: 200
- Namespace-scoped with `ax_` prefix
- Source tracking for audit trail

---

## 2. Command Collection Sources

### 2.1 Live Source Hierarchy (Priority Order)
1. **Obsidian Command Store** (Primary)
   - Path: `~/obsidian/mac-obsidian/10-CLI-COMMANDER/command-catalog.json`
   - Generated: 2026-08-04T05:42:16.825Z
   - Scope: User's custom commands + NCO ecosystem

2. **Bundled Resources** (Fallback for Electron)
   - Path: `app.asar/resources/command-catalog.json`
   - Used when Obsidian store unavailable
   - Snapshot for zero-config operation

3. **Project-Local Resources** (Development)
   - Path: `./resources/command-catalog.json`
   - Tested before fallback

### 2.2 Content Sources in Current Catalog
| Source | Count | Domain |
|--------|-------|--------|
| `/Users/nova-ai/.claude/commands` | 63 | claude-code |
| `/Users/nova-ai/.codex/prompts` | 101 | codex |
| `/Users/nova-ai/project/nco/.claude/commands` | 24 | nco-source |
| **Total Parsed** | **~240+** | multi-domain |

### 2.3 Provider Distribution
| Provider | Catalog Entries | Role |
|----------|---|---|
| nco | 151 | Multi-AI orchestration commands |
| codex | 101 | AI-assisted code/design workflow |
| claude-code | 63 | IDE integration commands |
| nco-source | 24 | NCO strategic routing |
| codex-built-in | 23 | Codex native commands |
| nova-use-browser | 17 | Browser automation |
| nova-use | 17 | NOVA Use platform |
| inter-session | 10 | Multi-session messaging |
| provider/meta-prompt | 4 | System-level |

---

## 3. Exact/Alias/AI Matching Priority

### 3.1 Static Command Resolution (Deterministic)
**File:** `cli-command-router.ts`

Priority cascade for voice input `/goal test`:
```
1. Exact match in COMMAND_ALIASES map: "goal" → "goal" ✓
2. Multi-word alias: "goal test" not in aliases → fallback
3. Korean phonetic boundary: "goal" (no Korean chars) → no boundary
4. Return: { command: "goal", arguments: "test" }
```

**Static Aliases** (Pre-defined, no AI):
- `/clear`, `/help`, `/model`, `/status`, `/init`, `/review`, `/plan`, `/diff`, `/goal`
- 9 base commands × 3-4 variants each = ~32 hardcoded routes

### 3.2 Catalog Command Resolution (Weighted Matching)
**File:** `command-catalog.ts` → `findSpokenCatalogCommand()`

For voice: `"nco discussion rest versus graphql"`

```
Step 1: Normalize & canonicalize
  Input: "nco discussion rest versus graphql"
  Tech terms: "엔씨오" → "nco", "디스커션" → "discussion"
  Canonical key: "ncodiscussion"

Step 2: Build index (canonicalized aliases)
  /nco-discussion → "ncoudiscussiontopicdiscussion"
  /nco-parallel → "ncoparalleldiscussiontopicdiscussions"
  Index: { <key>: "/nco-discussion", ... }

Step 3: Greedy prefix matching (longest first)
  for count from 7 down to 1:
    key = "ncodiscussionrestversusversusgrp"[0:count*words]
    if key in index:
      return { command: "/nco-discussion", args: "rest versus graphql" }

Result: ✓ Match at 2-word prefix "nco discussion"
```

**Matching Rules:**
- Greedy left-to-right (longest phrase first)
- One canonical key per command (no duplicates in index)
- Korean + English interchangeable (via SPOKEN_TECH_TERMS)

### 3.3 AI-Driven Meta-Mode Matching (Intent Recognition)
**File:** `command-catalog.ts` → `getMetaCommandCandidates()`

**Intent Rules Array (INTENT_RULES):**
- 17 regex patterns → command mappings
- Each pattern: `/(?:pattern)/i` matching user intent

Example: `/nco-company` matcher
```
Pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스|회사\s*(?:팀|조직)).*(?:위임|실행|작업|오케스트레이션)/i
Matches: "회사 팀에 AI 작업을 위임해줘" → `/nco-company`
Reason: "NOVA-AX 회사/팀 작업 위임"
```

**Priority Per Matched Rule:**
```
1. Catalog lookup: Find all entries with command == rule.command
2. Provider precedence: "codex" preferred if available (line 228)
3. Return: Up to 6 candidates with providers + reason
```

**AI Validation (Critical Gate):**
```typescript
isAllowedMetaCommand(output, candidates): boolean {
  // Output starts with "/" → MUST be in candidates
  // No invented commands allowed
}
```

---

## 4. CLI-Focus Safety Gate

### 4.1 Target App Detection
**File:** `cli-command-router.ts`

**Bundle ID Whitelist:**
```typescript
const CLI_BUNDLE_IDS = [
  'com.apple.terminal',
  'com.googlecode.iterm2',
  'dev.warp.warp-stable',
  'dev.warp.warp',
  'com.mitchellh.ghostty',
  'net.kovidgoyal.kitty',
  'org.alacritty',
  'com.github.wez.wezterm',
  'co.zeit.hyper',
  'com.nova.nova-use'  // NOVA Use browser
]
```

**App Name Pattern Fallback:**
```regex
(?:^|\s)(terminal|iterm|warp|ghostty|kitty|alacritty|wezterm|hyper|nova use)(?:$|\s)/i
```

**Result:** `isCliTarget(appName, bundleId) → boolean`

### 4.2 Meta-Mode Instruction Injection (Context-Aware Safety)
**File:** `nco-meta-prompt.ts` (lines 166-239)

**Conditions for CLI command inclusion:**
```typescript
const includeCli = context.cliTarget === true
  && (includeTarget || /(?:CLI|터미널|명령어|슬래시|\/[a-z][a-z-]*)/i.test(safeInput))

if (includeCli) {
  // Inject: "CLI/터미널 맥락: 예"
  // + command candidates (up to 6)
  // + tool candidates (up to 4)
}
```

**Non-CLI Context (Explicit Gate):**
```
If context.cliTarget === false:
  Inject: "CLI/터미널 맥락: 아니요. slash command를 출력하지 않는다."
```

### 4.3 Output Validation (Post-Generation)
**File:** `nco-meta-prompt.ts` (lines 247-314)

**Slash Command Gating (line 284-292):**
```typescript
if (compactOutput.startsWith('/')) {
  if (
    context.cliTarget !== true              // ← Must be CLI target
    || output.includes('\n')                // ← Single-line only
    || !isAllowedMetaCommand(compactOutput, context.commandCandidates) // ← Allowlist check
  ) {
    throw new Error('NCO returned a slash command outside the allowed catalog candidates')
  }
  return compactOutput
}
```

**Inline Slash Token Detection (line 294-300):**
```typescript
const inlineSlashTokens = [...output.matchAll(/\/[A-Za-z][A-Za-z0-9:_-]*/g)]
const ungroundedSlashToken = inlineSlashTokens.find(token => 
  !input.includes(token)                    // ← Not in original input
  && !candidates.some(c => c.command === token) // ← Not in allowlist
)
if (ungroundedSlashToken) {
  throw new Error(`NCO invented an ungrounded slash token: ${ungroundedSlashToken}`)
}
```

---

## 5. Allowlist Enforcement & Validation

### 5.1 Multi-Layer Gating Architecture

#### Layer 1: Catalog Load-Time Validation
```typescript
function readCatalog(filePath): { commands: [], novaAxTools: [] } {
  if (parsed.schemaVersion !== 1) return { commands: [] }  // ← Schema version check
  
  commands.forEach(raw => {
    if (!COMMAND_PATTERN.test(command)) return []          // ← Regex validation
    aliases = aliases.slice(0, 12)                         // ← Max 12 aliases
  })
}
```

#### Layer 2: Voice-to-Command Resolution
```
Static commands (hardcoded) → Catalog exact match → Catalog alias match
```

#### Layer 3: Meta-Mode AI Output Validation
```
AI generates text →
  ├─ Starts with "/"?
  │  ├─ Yes: Is it in candidates + single-line + cliTarget=true?
  │  └─ No: Throw "ungrounded slash token"
  └─ No: Return as free text
```

#### Layer 4: Instruction Injection Gating
```
isAllowedMetaCommand(output, candidates) {
  return candidates.some(c => c.command === output.split(' ')[0])
}
```

### 5.2 Validation Functions (Defensive Design)

**`cleanField(value)` (Line 131-135):**
- Removes null bytes, control chars
- Normalizes whitespace
- Caps at 500 chars
- Type-safe string conversion

**`isAllowedMetaCommand(output, candidates)` (Line 251-254):**
```typescript
// Critical: Prevents AI from inventing commands
const command = output.trim().split(/\s+/, 1)[0]
return Boolean(candidates?.some(c => c.command === command))
```

**`cleanMetaPromptOutput(value, input, context)` (Line 247-314):**
- 10+ validation rules including:
  - Echo detection (same as input?)
  - Template detection (fixed prompts?)
  - Slash token verification
  - Depth validation for complex requests
  - NOVA VOICE review completeness check

**Similarity Test (Line 280-281):**
```typescript
const compactOutput = output.replace(/\s+/g, ' ').trim()
const compactInput = input.replace(/\s+/g, ' ').trim()
if (compactOutput === compactInput || compactInput.includes(compactOutput)) {
  throw new Error('NCO echoed the transcript instead of answering it')
}
```

---

## 6. Test Scenarios & Verification Coverage

### 6.1 Catalog Loading & Caching

#### Test: Catalog Path Resolution
```typescript
Test: catalogPaths()
Input: process.resourcesPath = "/Applications/nova-voice.app/resources"
Expected: Returns candidates in priority order
  1. ~/obsidian/mac-obsidian/.../command-catalog.json
  2. app.asar/resources/command-catalog.json
  3. ./resources/command-catalog.json
Verify: stat().mtimeMs for cache invalidation
```

#### Test: Invalid Catalog Schema
```typescript
Input: { schemaVersion: 2, commands: [...] }
Expected: readCatalog() returns { commands: [], novaAxTools: [] }
Verify: No commands loaded, fallback to cached

Input: { schemaVersion: 1, commands: "not an array" }
Expected: Early return { commands: [], novaAxTools: [] }
Verify: Type guard prevents crash
```

#### Test: Field Sanitization
```typescript
Input: { command: "/test\x00command\x1f", provider: "foo\n\nbar" }
After cleanField(): "/testcommand", "foo bar"
Verify: Control chars removed, whitespace normalized
```

### 6.2 Static Command Resolution

#### Test: Hardcoded Alias Matching
```typescript
Input: "goal test implementation"
Expected: 
  - Tokenize: ["goal", "test", "implementation"]
  - Lookup: normalizeAlias("goal test") → no match
  - Fallback: normalizeAlias("goal") → "goal"
  - Return: { command: "goal", arguments: "test implementation" }

Verify: exactlyOneMatch, argumentsPreserved
```

#### Test: Korean Phonetic Boundary (Boundary Case)
```typescript
Input: "골노바유즈" (Korean, should NOT trigger "goal" + "nova-use")
- "골" (gol) alias checks: no match in COMMAND_ALIASES
- "고ㄹ노바유즈" (partial Korean word) → rejected
Expected: Return false (not a command boundary)

Verify: /[가-힣]$/ test prevents false positives
```

#### Test: English + Korean Mix
```typescript
Input: "goal 노바 유즈 test" (goal + NOVA Use + test)
Expected:
  - "goal" matches → command: "goal"
  - "노바 유즈" in product names (allowed in args)
  - Return: { command: "goal", arguments: "노바 유즈 test" }

Verify: Boundaries respected, args preserved
```

### 6.3 Catalog Intent Matching

#### Test: Pattern Matching (NCO Discussion)
```typescript
Input: "여러 AI가 REST와 GraphQL을 토론해줘"
Intent Rule: /(?:여러|복수|멀티)?\s*(?:AI|프로바이더)?.*(?:토론|논의|찬반)/i
Expected:
  1. Pattern matches → rule.command = "/nco-discussion"
  2. Catalog lookup: Find all entries with command="/nco-discussion"
  3. Filter by provider: codex preferred (line 228)
  4. Return: MetaCommandCandidate {
       command: "/nco-discussion",
       usage: "/nco-discussion 토론 주제",
       description: "멀티 AI 토론을 시작합니다",
       providers: ["claude-code", "codex", "nco-source"],
       reason: "다중 AI 토론"
     }

Verify: exactlyOneCandidate, providersListed, reasonIncluded
```

#### Test: Multiple Matching Rules
```typescript
Input: "회사에 작업을 위임해줄 수 있어?"
Matches:
  1. /nco-company-cancel → "NOVA-AX 회사 실행 취소"
  2. /nco-company → "NOVA-AX 회사/팀 작업 위임"
  3. /nco-parallel → "다중 provider 병렬 실행"

Expected: candidates.slice(0, 6) returns first 6 matches in rule order
Verify: Deterministic ordering (INTENT_RULES order)
```

#### Test: No Match
```typescript
Input: "오늘 날씨가 어떻게 되나?"
Expected: getMetaCommandCandidates() returns []
Verify: No invalid candidates created
```

### 6.4 Meta-Mode Routing (NCO vs Local AI)

#### Test: NCO Provider Success Path
```typescript
Input: "STT 앱을 리뷰해줘"
Context: { cliTarget: false }

1. Build instruction: metaPromptInstruction(input, context)
2. POST /api/task {ai: "codex", prompt: "...", priority: 1}
3. Poll /api/task/{taskId} every 650ms
4. Receive: { status: "completed", response: "장점은..." }
5. Validate: cleanMetaPromptOutput()
6. Return: ResolvedMetaPromptResult {
     text: "장점은...",
     outcome: "completed",
     provider: "NCO · codex",
     taskId: "..."
   }

Verify: taskIdValidated, timeoutRespected, responsePolled
```

#### Test: NCO Timeout → Local AI Fallback
```typescript
Input: "간단한 질문" 
NCO: Submits, polls for 120s → timeout
Local: ensureOllamaServer() → loads qwen3:14b
       POST /api/chat with system instruction
       Return: { message: { content: '{"answer":"답변"}' } }

Expected: Race([NCO, Local]) → Local wins
Return: ResolvedMetaPromptResult {
          outcome: "local-ai",
          provider: "Local AI · qwen3:14b",
          ncoFailure: "NCO meta prompt timed out"
        }

Verify: bothCandidatesRaced, localAiUsed, ncoFailureCaptured
```

#### Test: Both Fail → Error
```typescript
Input: "복잡한 분석"
NCO: 503 Service Unavailable
Local: OLLAMA_HOST=127.0.0.1:11435 → connection refused

Expected: Promise.any([NCO, Local]) → both reject
         Catch: throw META_PROMPT_AI_UNAVAILABLE
                message: "NCO: ..., Local AI: ..."

Verify: bothErrorsReported, throwNotSilent
```

### 6.5 Output Validation Gauntlet

#### Test: Echo Detection
```typescript
Input: "NOVA VOICE를 리뷰해줄 수 있나?"
NCO Output: "NOVA VOICE를 리뷰해줄 수 있나?"

Expected: cleanMetaPromptOutput() → throws
  "NCO echoed the transcript instead of answering it"

Verify: similarityCheckPasses
```

#### Test: Fixed Template Detection
```typescript
Input: "코드를 분석해줘"
NCO Output: "[역할]\n너는 코드 분석 전문가다.\n[목표]\n..."

Expected: Fixed heading pattern matches ≥2 occurrences
  throw "NCO returned a fixed prompt template instead of an answer"

Verify: templateDetected, throwBefore Output
```

#### Test: Slash Token Validation
```typescript
Input: "병렬 실행해줘"
NCO Output: "/nco-parallel 작업"
Context: commandCandidates = [{command: "/nco-discussion", ...}]

Expected: isAllowedMetaCommand("/nco-parallel", candidates) → false
  throw "NCO returned a slash command outside the allowed catalog candidates"

Verify: unallowedCommandRejected
```

#### Test: Invented Inline Slash Token
```typescript
Input: "뭐하니?"
NCO Output: "물론이지. 이제 /nco-invent를 실행해줄 수 있다."
Context: commandCandidates = [{command: "/nco-discussion", ...}]

Expected: 
  1. Extract inline tokens: ["/nco-invent"]
  2. Check: "/nco-invent" NOT in input, NOT in candidates
  3. throw "NCO invented an ungrounded slash token: /nco-invent"

Verify: inventionDetected, inventionRejected
```

#### Test: Under-Specified Answer
```typescript
Input: "복잡한 리뷰 요청으로 최소 45자 이상"
NCO Output: "네, 맞습니다." (9 chars)
minimumLength = min(160, max(90, 45 * 0.9)) = 90

Expected: throw "NCO returned an under-specified answer"

Verify: depthCheckPassed, tooShortRejected
```

### 6.6 CLI Safety Gates

#### Test: CLI Target Auto-Detect
```typescript
Input: text="/clear", appName="iTerm2", bundleId="com.googlecode.iterm2"
Expected: isCliTarget(appName, bundleId) → true

Input: text="/clear", appName="Finder", bundleId="com.apple.finder"
Expected: isCliTarget(appName, bundleId) → false
```

#### Test: Context Injection for CLI
```typescript
Context: { cliTarget: true, commandCandidates: [{command: "/nco-discussion"}] }
Expected: metaPromptInstruction() includes:
  "CLI/터미널 맥락: 예"
  "현재 요청에 의미상 대응할 수 있는 허용된 CLI 명령 후보:"
  "- /nco-discussion 토론 주제 — ... (다중 AI 토론)"

Input: text=""/nco-discussion"
Expected: NCO can choose to return "/nco-discussion ..." (allowed)
```

#### Test: Non-CLI Context Blocks Commands
```typescript
Context: { cliTarget: false }
Expected: metaPromptInstruction() includes:
  "CLI/터미널 맥락: 아니요. slash command를 출력하지 않는다."
  (commandCandidates NOT injected)

Input: text="/nco-discussion" request
Expected: NCO should NOT output "/nco-discussion"
          (contextually guided, not technicallyBlockaded)
```

### 6.7 NOVA-AX Tool Safety

#### Test: Tool Candidate Detection
```typescript
Input: "NOVA-AX 상태를 확인해줄 수 있나?"
Rules match: ax_health, ax_dashboard, ax_status

Expected: getMetaToolCandidates() returns up to 4:
  [{name: "ax_health", description: "...", reason: "..."}, ...]

Verify: toolNamesInNamespace, returnedToContext, maxOf4
```

#### Test: Tool Output Validation
```typescript
Context: toolCandidates = [{name: "ax_health"}]
NCO Output: "ax_health 도구를 사용하여 NCO 상태를 확인했습니다. [results]"

Expected: cleanMetaPromptOutput() checks:
  - Tool is not executed in meta mode
  - Output should NOT claim tool execution without actual results
  throw if: /(?:실행|확인|조회)했습니다/ without proof

Verify: claimsNotAllowed, metatextPresent
```

---

## 7. Safety & Security Assessment

### 7.1 Strengths ✓
1. **Multi-layer validation:** Catalog schema → field sanitization → output validation
2. **Allowlist enforcement:** Candidates pre-computed, AI output gated against allowlist
3. **Deterministic routing:** Static commands don't depend on ML/AI
4. **App targeting:** Bundle ID + pattern matching for CLI-only commands
5. **Token capture:** Regex-based slash token detection + inventor check
6. **Context isolation:** Command candidates injected selectively (CLI-only)

### 7.2 Edge Cases / Potential Issues ⚠️

#### Issue: Alias Collision
```typescript
Scenario: Both "/nco-task" and "/nco-task-parallel" in aliases
Canonicalized key could collide if aliasing done incorrectly
Current: Uses full alias in index (line 203-205) → OK
Risk: Low (but test multiword aliases with shared prefixes)
```

#### Issue: Command Pattern Looser Than Validation
```
Validation: /^\/[A-Za-z0-9가-힣][A-Za-z0-9가-힣:_-]{0,80}$/
Allows: "/" + 1 char + up to 80 more = 82 chars total
Capped: cleanField() @ 500 chars anyway
Risk: Low (pattern is conservative)
```

#### Issue: Korean Phonetic Ambiguity
```
Input: "엔씨오" → "nco" (expected)
But: "엔" (eun) could be confused with "은" in other context
Current: Explicit SPOKEN_TECH_TERMS map prevents auto-generation
Risk: Low (manually curated, 26 rules tested)
```

#### Issue: Recent Inputs Leakage
```
Meta mode includes recentInputs[] in context (line 173-176)
These could contain sensitive data from prior requests
Current: Redacted via redactSecrets() before instruction injection
Risk: Medium (still serialized in memory, not cryptographically protected)
Mitigation: Trim to 3 items, cap at 500 chars per item
```

#### Issue: AI Output Can Claim false Execution
```
Example: "ax_health 도구로 확인했습니다. 상태: 정상"
Without actual tool execution
Current: Check disabled (marked "실행 결과가 제공되지 않았다면" = if results not provided)
Risk: Medium (AI can hallucinate tool outputs)
Mitigation: Require actual MCP invocation in same session
```

---

## 8. Recommendations for Hardening

### Priority 1: Critical
- [ ] **Implement command audit logging:** Log all NCO/Local meta outputs → /var/log/nova-voice/meta-*.log
- [ ] **Add whitelist versioning:** Include schema version + command checksum in allowlist file
- [ ] **Separate tool execution:** Only allow ax_* tools if actual MCP result provided in same transaction

### Priority 2: High
- [ ] **Context replay detection:** Mark and reject requests that echo within 2 min (avoid prompt injection via clipboard)
- [ ] **Provider circuit breaker:** After 3 consecutive failures from provider, force fallback for 60s (current retry: 60s global)
- [ ] **Instrumentation:** Add metrics for candidate matching accuracy (how often AI respects allowlist)

### Priority 3: Medium
- [ ] **Static alias expansion:** Pre-compute all resolved paths to catch alias collisions at load time
- [ ] **Command lifecycle:** Add deprecation markers to command-catalog.json (e.g., "until": "2026-12-31")
- [ ] **A/B test matching:** Compare user intent → matched command → actual invocation to measure matching precision

---

## 9. Test Scenario Summary Table

| Scenario | File | Function | Expected | Risk |
|----------|------|----------|----------|------|
| Catalog schema version invalid | `command-catalog.ts` | `readCatalog()` | Return empty | Low |
| Static alias with Korean boundary | `cli-command-router.ts` | `findStaticCommand()` | No false positive | Low |
| Multiple matching intent rules | `command-catalog.ts` | `getMetaCommandCandidates()` | Top 6 deterministic | Low |
| NCO timeout → local fallback | `nco-meta-prompt.ts` | `rewriteMetaPrompt()` | Race won by local | Low |
| Invented slash token in output | `nco-meta-prompt.ts` | `cleanMetaPromptOutput()` | Throw error | **Critical** |
| Slash command outside allowlist | `nco-meta-prompt.ts` | `isAllowedMetaCommand()` | Gate output | **Critical** |
| Non-CLI context receives /command | `local-ai-meta-prompt.ts` | `cleanOutput()` | Same validation | Medium |
| Tool claimed without execution | `nco-meta-prompt.ts` | `cleanMetaPromptOutput()` | Detect via pattern | Medium |
| Echo detection (input ≈ output) | `nco-meta-prompt.ts` | `cleanMetaPromptOutput()` | Throw error | Low |
| Under-specified answer for complex query | `nco-meta-prompt.ts` | `cleanMetaPromptOutput()` | Throw error | Low |

---

## 10. Data Flow Diagram

```
User Voice Input
  ↓
[Whisper STT]
  ↓
Text Transcript
  ↓
┌─────────────────────────────────────────────────┐
│ ROUTING DECISION: Voice or Meta-AI?             │
└─────────────────────────────────────────────────┘
  ├─→ Direct transcription mode (no AI)
  │     ↓
  │   [routeVoicePrompt]
  │     ├─→ Static command? → /goal, /clear, etc.
  │     ├─→ Catalog command? → /nco-discussion
  │     └─→ Free text → direct input
  │
  └─→ Meta-AI mode (AI rewrites intent)
        ↓
      [rewriteMetaPrompt]
        ├─→ [getMetaCommandCandidates] ← INTENT RULES
        │    ↓ (up to 6 candidates)
        │
        ├─→ [getMetaToolCandidates] ← TOOL RULES
        │    ↓ (up to 4 candidates)
        │
        ├─→ Build instruction (inject context)
        │    ├─ Target app + CLI status
        │    ├─ Command candidates (gated by cliTarget)
        │    ├─ Tool candidates
        │    └─ Recent inputs (trimmed, sanitized)
        │
        ├─→ Race([NCO, Local AI]) → First to complete
        │    │
        │    ├─→ NCO path:
        │    │    POST /api/task
        │    │    Poll /api/task/{taskId}
        │    │    [cleanMetaPromptOutput] ← VALIDATION GAUNTLET
        │    │
        │    └─→ Local path:
        │         ensureOllamaServer() → qwen3:14b
        │         POST /api/chat
        │         [cleanOutput] ← VALIDATION GAUNTLET
        │
        ├─→ Output validation (both providers):
        │    ├─ Echo detection
        │    ├─ Template detection
        │    ├─ Slash token verification
        │    │   └─ [isAllowedMetaCommand] ← ALLOWLIST GATE
        │    ├─ Invented token detection
        │    ├─ Depth validation
        │    └─ NOVA VOICE review completeness
        │
        └─→ Approved Output
             ├─→ "/" prefix? → [CLI gate + single-line check]
             └─→ Free text → Return as-is
```

---

## Conclusion

NOVA VOICE's provider slash-command catalog and meta-mode routing implement **defense-in-depth** against:
- **Command injection:** Allowlist validates before execution
- **AI hallucination:** Output validation detects invented commands
- **Context leakage:** Selective injection (CLI-only) + sanitization
- **Prompt injection:** Instruction structure guards against middle instructions
- **Provider outage:** Dual-provider race with local fallback

**Recommendation:** System is **production-ready** with suggested Priority 1 audit logging for compliance.

