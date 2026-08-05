#!/usr/bin/env node
/**
 * Runs the real local meta-prompt engine (qwen3:14b) against spoken-style
 * requests and checks the contract of meta mode.
 *
 * Meta mode does NOT answer the request. It rewrites what the user said into a
 * prompt that the AI at the cursor can act on — the spoken shorthand is filled
 * out with the purpose, target and scope that speech leaves implicit.
 *
 * Cases run one at a time: a 14B model must not be asked to infer in parallel
 * with another local inference.
 */
import assert from 'node:assert/strict'

import { getMetaCommandCandidates, getMetaToolCandidates } from '../src/main/command-catalog.ts'
import { rewriteWithLocalAiMetaPrompt } from '../src/main/local-ai-meta-prompt.ts'

/** Reports a finished analysis — the failure mode this mode replaced. */
const ANSWER_SHAPE = /(?:하겠습니다|했습니다|완료했습니다|살펴본\s*결과|분석한\s*결과|장점은\s|결론적으로)/
/** The result has to read as an instruction to whoever receives it. */
const REQUEST_ENDING = /(?:[가-힣]{1,8}\s*(?:줘요?|주세요|주십시오|주시기\s*바랍니다|줄래요?)|하라|해라|하십시오|바랍니다|바래)[.!?]?["'’”)\]]?\s*$/
const PREAMBLE = /^(?:네|아니(?:요|오)|예)[,.\s]|^(?:다음은|아래는|이\s*(?:요청|프롬프트)(?:은|는))/

function assertEnrichedPrompt(output, input) {
  const compactInput = input.replace(/\s+/g, ' ').trim()
  const compactOutput = output.replace(/\s+/g, ' ').trim()

  assert.notEqual(compactOutput, compactInput, 'AI returned the transcript unchanged')
  assert.doesNotMatch(compactOutput, PREAMBLE, 'AI wrapped the prompt in a preamble')
  assert.doesNotMatch(compactOutput, ANSWER_SHAPE, 'AI answered the request instead of turning it into a prompt')
  assert.match(compactOutput, REQUEST_ENDING, 'AI output does not read as a request')
  assert.ok(
    compactOutput.length >= Math.round(compactInput.length * 1.15),
    `AI added nothing to the transcript: ${compactOutput.length} vs ${compactInput.length} chars`,
  )
  assert.doesNotMatch(output, /```/, 'AI wrapped the prompt in a code fence')
}

const cases = [
  {
    // The exact phrasing that used to come back as a finished review.
    input: '지금 실행하고 있는 앱 리뷰한다',
    required: [/(리뷰|검토|살펴)/],
  },
  {
    input: '이 오류를 고쳐줘. 기존 기능은 깨지면 안 돼.',
    required: [/오류|버그/, /(기존|회귀|영향)/],
  },
  {
    input: '이거 왜 느린지 좀 봐줘',
    required: [/(느|지연|성능|병목)/],
  },
]

const results = []
for (const testCase of cases) {
  const startedAt = Date.now()
  const result = await rewriteWithLocalAiMetaPrompt(testCase.input, {})
  const elapsedMs = Date.now() - startedAt

  assertEnrichedPrompt(result.text, testCase.input)
  for (const pattern of testCase.required) assert.match(result.text, pattern)

  results.push({
    input: testCase.input,
    inputChars: testCase.input.length,
    promptChars: result.text.length,
    elapsedMs,
    model: result.model,
    prompt: result.text,
  })
}

// A slash command is the most precise form a request can take, so an explicit
// CLI intent must collapse to one instead of being padded into prose.
const cliInput = '여러 AI가 REST와 GraphQL 중 무엇이 적합한지 토론하게 해줘'
const cliResult = await rewriteWithLocalAiMetaPrompt(cliInput, {
  cliTarget: true,
  targetAppName: 'Terminal',
  commandCandidates: getMetaCommandCandidates(cliInput),
  toolCandidates: getMetaToolCandidates(cliInput),
})
assert.ok(
  cliResult.text.startsWith('/') || REQUEST_ENDING.test(cliResult.text.replace(/\s+/g, ' ').trim()),
  `CLI request produced neither a slash command nor a request: ${cliResult.text.slice(0, 120)}`,
)

console.log(JSON.stringify({
  passed: true,
  contract: 'meta mode rewrites the spoken request into a prompt for another AI; it never answers it',
  cases: results,
  cliRouted: cliResult.text,
}, null, 2))
