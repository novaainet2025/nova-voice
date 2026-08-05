import assert from 'node:assert/strict'

import { getMetaCommandCandidates, getMetaToolCandidates } from '../src/main/command-catalog.ts'
import { rewriteWithLocalAiMetaPrompt } from '../src/main/local-ai-meta-prompt.ts'

const downstreamGuide = /(?:NOVA VOICE의\s*음성\s*요청을\s*실행용|원문의\s*(?:의도|대상|범위|제약).*(?:보존|유지)|(?:실행용\s*)?(?:prompt|프롬프트)(?:로|를)\s*(?:변환|재구성)(?:해|하)|후속\s*AI)/i
const downstreamImperative = /(?:해\s*줘|해주세요|해라|하라|해\s*주십시오|하십시오)[.!?]?\s*$/i

function assertFinalAnswer(output, input) {
  const compactInput = input.replace(/\s+/g, ' ').trim()
  const compactOutput = output.replace(/\s+/g, ' ').trim()
  assert.notEqual(compactOutput, compactInput, 'AI returned the transcript unchanged')
  assert.equal(compactOutput.includes(compactInput), false, 'AI quoted the full transcript instead of answering it')
  assert.doesNotMatch(output, /(?:\[역할\]|\[목표\]|\[요구사항\]|\[완료\s*기준\])/) 
  assert.doesNotMatch(output, downstreamGuide, 'AI exposed a downstream meta-prompt guide')
  assert.doesNotMatch(output, downstreamImperative, 'AI returned a prompt for another AI instead of a final answer')
  assert.doesNotMatch(output, /(?:TTS|내장\s*AI\s*터미널).*(?:복원|재추가|다시\s*추가)/is)
  if (/(?:NOVA\s*VOICE|NOVA-AX|NOVA\s*Use|NCO)/i.test(input)) {
    assert.doesNotMatch(output, /(?:리뷰|검토)?\s*대상(?:이|은|을)?\s*(?:명확하지|불명확)/i)
  }
}

const cases = [
  {
    input: 'NOVA VOICE를 리뷰해줘.',
    required: [/(리뷰|검토|평가|장점)/, /(?:Whisper|음성\s*인식|STT)/i, /(?:메타|NCO|AI)/i, /(문제|위험|개선|우선)/],
    minimumLength: 90,
  },
  {
    input: 'NOVA VOICE 최적화를 진행한다. 지금 meta prompt 기능이 제대로 작동하지 않고 있어.',
    required: [/meta\s*prompt|메타\s*프롬프트/i, /(원인|문제|오류|실패|동작|작동)/, /(개선|수정|최적화|점검|조치)/],
    minimumLength: 90,
  },
  {
    input: '이 오류를 고쳐줘. 기존 기능은 깨지면 안 돼.',
    required: [/오류/, /기존\s*기능/, /(재현|원인|정보|로그)/, /(영향|안전|검증|테스트|회귀)/],
    minimumLength: 90,
  },
]

const results = []
for (const testCase of cases) {
  const startedAt = Date.now()
  const result = await rewriteWithLocalAiMetaPrompt(testCase.input, {})
  const elapsedMs = Date.now() - startedAt

  assertFinalAnswer(result.text, testCase.input)
  for (const pattern of testCase.required) assert.match(result.text, pattern)
  assert.ok(result.text.length >= testCase.minimumLength, `AI final answer is too shallow for ${JSON.stringify(testCase.input)}: ${result.text.length} chars`)
  assert.ok(elapsedMs < 30_000, `AI answer exceeded 30 seconds: ${elapsedMs}ms`)
  results.push({ input: testCase.input, output: result.text, provider: result.model, elapsedMs })
}

const discussionInput = '여러 AI가 REST와 GraphQL 중 무엇이 이 서비스에 적합한지 토론해'
const discussionCandidates = getMetaCommandCandidates(discussionInput)
assert.equal(discussionCandidates[0]?.command, '/nco-discussion')
const discussion = await rewriteWithLocalAiMetaPrompt(discussionInput, {
  targetAppName: 'NOVA Use',
  targetBundleId: 'com.nova.use',
  cliTarget: true,
  commandCandidates: discussionCandidates,
})
assert.match(discussion.text, /^\/nco-discussion(?:\s|$)/)

const nonCliDiscussion = await rewriteWithLocalAiMetaPrompt(discussionInput, {
  targetAppName: 'TextEdit',
  targetBundleId: 'com.apple.TextEdit',
  cliTarget: false,
  commandCandidates: discussionCandidates,
})
assertFinalAnswer(nonCliDiscussion.text, discussionInput)
assert.doesNotMatch(nonCliDiscussion.text, /^\//)
assert.match(nonCliDiscussion.text, /REST/)
assert.match(nonCliDiscussion.text, /GraphQL/)
assert.match(nonCliDiscussion.text, /(리소스|캐시|단순)/)
assert.match(nonCliDiscussion.text, /(필드|스키마|유연|데이터|네트워크)/)
assert.match(nonCliDiscussion.text, /(선택|적합|권장|판단)/)

const noCandidateInput = '이 문장의 오탈자를 자연스럽게 고쳐줘'
const noCandidate = await rewriteWithLocalAiMetaPrompt(noCandidateInput, {
  targetAppName: 'Terminal',
  targetBundleId: 'com.apple.Terminal',
  cliTarget: true,
  commandCandidates: [],
})
assertFinalAnswer(noCandidate.text, noCandidateInput)
assert.doesNotMatch(noCandidate.text, /^\//)
assert.match(noCandidate.text, /(문장|원문).*(없|필요|제공)|(?:없|필요|제공).*(문장|원문)/)

const novaAxInput = 'NOVA-AX 서버 상태와 연결이 정상인지 확인해'
const novaAx = await rewriteWithLocalAiMetaPrompt(novaAxInput, {
  targetAppName: 'NOVA Use',
  targetBundleId: 'com.nova.use',
  cliTarget: true,
  commandCandidates: getMetaCommandCandidates(novaAxInput),
  toolCandidates: getMetaToolCandidates(novaAxInput),
})
assertFinalAnswer(novaAx.text, novaAxInput)
assert.doesNotMatch(novaAx.text, /^\//)
assert.match(novaAx.text, /ax_health/)
assert.match(novaAx.text, /(확인할 수 없|실행 결과|현재.*상태|직접.*확인)/)
assert.doesNotMatch(novaAx.text, /\/[A-Za-z][A-Za-z0-9:_-]*/)

results.push(
  { input: discussionInput, output: discussion.text, provider: discussion.model, route: '/nco-discussion' },
  { input: discussionInput, output: nonCliDiscussion.text, provider: nonCliDiscussion.model, route: 'direct-answer' },
  { input: noCandidateInput, output: noCandidate.text, provider: noCandidate.model, route: 'direct-answer' },
  { input: novaAxInput, output: novaAx.text, provider: novaAx.model, route: 'NOVA-AX status answer' },
)

console.log(JSON.stringify({ passed: true, contract: 'internal-meta-prompt-to-final-answer', cases: results }, null, 2))
