#!/usr/bin/env node
/**
 * End-to-end check of the streamed STT capture against the running Whisper
 * server, using real synthesised Korean speech.
 *
 * Guarantees under test:
 *   1. `info` (the post-finalize engine echo) always arrives after every
 *      `final`, so it is a safe terminator.
 *   2. An utterance with a pause longer than the server's 0.7s VAD window is
 *      reassembled from all its segments instead of being truncated.
 *   3. Streaming while the user speaks leaves far less work after the recording
 *      stops than uploading the whole buffer afterwards.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const STT_WS_URL = 'ws://127.0.0.1:8765/ws/stt'
const CHUNK_BYTES = 4096 * 2
const FINALIZE_SILENCE_CHUNKS = 4
const TRAILING_SILENCE_MS = 900
const SENTENCES = [
  '노바 보이스는 마이크 입력을 실시간으로 서버에 보냅니다',
  '그래서 녹음이 끝나는 순간 이미 인식이 완료되어 있습니다',
  '응답 지연이 크게 줄어듭니다',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function synthesise() {
  if (process.platform !== 'darwin') return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-stt-'))
  const aiff = path.join(dir, 'speech.aiff')
  const wav = path.join(dir, 'speech.wav')
  // 1.4s / 1.2s gaps sit well past the server VAD's 0.7s window, so this is
  // deliberately the utterance shape that used to be truncated.
  const script = `${SENTENCES[0]} [[slnc 1400]] ${SENTENCES[1]} [[slnc 1200]] ${SENTENCES[2]}`
  execFileSync('say', ['-v', 'Yuna', script, '-o', aiff], { stdio: 'ignore' })
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav], { stdio: 'ignore' })
  return { dir, pcm: fs.readFileSync(wav).subarray(44) }
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(STT_WS_URL)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function attach(socket) {
  const events = []
  const finals = []
  let terminate
  const terminated = new Promise((resolve) => { terminate = resolve })
  socket.on('message', (data) => {
    let message
    try { message = JSON.parse(data.toString()) } catch { return }
    events.push({ type: message.type, at: Date.now() })
    if (message.type === 'final') {
      const text = (message.text || '').trim()
      if (text) finals.push(text)
    } else if (message.type === 'info' || message.type === 'error') {
      terminate(message.type)
    }
  })
  return { events, finals, terminated }
}

function sendTerminator(socket) {
  const silence = Buffer.alloc(CHUNK_BYTES)
  for (let index = 0; index < FINALIZE_SILENCE_CHUNKS; index++) socket.send(silence)
  socket.send(JSON.stringify({ finalize: true }))
  // `finalize` answers only when no segment final was sent yet. The engine echo
  // always answers and, because the server handler is sequential, it can only
  // be processed after every final.
  socket.send(JSON.stringify({ engine: 'mlx' }))
}

async function buffered(pcm) {
  const socket = await connect()
  const { events, finals, terminated } = attach(socket)
  const startedAt = Date.now()
  socket.send(JSON.stringify({ partials: false }))
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    socket.send(pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length)))
  }
  sendTerminator(socket)
  await terminated
  const elapsedMs = Date.now() - startedAt
  socket.close()
  return { elapsedMs, finals, events }
}

async function streamed(pcm) {
  const socket = await connect()
  const { events, finals, terminated } = attach(socket)
  socket.send(JSON.stringify({ partials: false }))
  // 4096 samples @16 kHz = 256ms per chunk, paced like a live microphone.
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    socket.send(pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length)))
    await sleep(256)
  }
  const trailing = Buffer.alloc(CHUNK_BYTES)
  for (let elapsed = 0; elapsed < TRAILING_SILENCE_MS; elapsed += 256) {
    socket.send(trailing)
    await sleep(256)
  }
  // Everything above happens while the user is still holding the recording.
  const startedAt = Date.now()
  sendTerminator(socket)
  await terminated
  const elapsedMs = Date.now() - startedAt
  socket.close()
  return { elapsedMs, finals, events }
}

const speech = synthesise()
if (!speech) {
  console.log(JSON.stringify({ skipped: 'macOS `say` is required to synthesise test speech' }))
  process.exit(0)
}

try {
  await buffered(speech.pcm)                    // warm the MLX model
  // Both paths are measured twice and compared on their best run. A single
  // sample is dominated by whatever else is competing for the ANE at that
  // moment, which says nothing about the change being measured.
  const bufferedRuns = [await buffered(speech.pcm), await buffered(speech.pcm)]
  const streamedRuns = [await streamed(speech.pcm), await streamed(speech.pcm)]
  const bufferedRun = bufferedRuns.reduce((a, b) => (a.elapsedMs <= b.elapsedMs ? a : b))
  const streamedRun = streamedRuns.reduce((a, b) => (a.elapsedMs <= b.elapsedMs ? a : b))

  for (const [label, run] of [...bufferedRuns.map((r) => ['buffered', r]), ...streamedRuns.map((r) => ['streamed', r])]) {
    const lastFinal = run.events.filter((event) => event.type === 'final').at(-1)
    const terminator = run.events.find((event) => event.type === 'info')
    assert.ok(terminator, `${label}: no info terminator was received`)
    assert.ok(lastFinal, `${label}: no final was received`)
    assert.ok(terminator.at >= lastFinal.at, `${label}: the terminator raced ahead of a final`)

    const transcript = run.finals.join(' ')
    for (const sentence of SENTENCES) {
      const head = sentence.slice(0, 8)
      assert.ok(transcript.includes(head), `${label}: lost a segment starting with "${head}"`)
    }
  }

  assert.ok(
    streamedRun.elapsedMs < bufferedRun.elapsedMs,
    `streaming saved no time (streamed ${streamedRun.elapsedMs}ms vs buffered ${bufferedRun.elapsedMs}ms)`,
  )

  console.log(JSON.stringify({
    passed: true,
    audioSeconds: +(speech.pcm.length / 32_000).toFixed(2),
    bufferedMs: bufferedRun.elapsedMs,
    streamedMs: streamedRun.elapsedMs,
    savedMs: bufferedRun.elapsedMs - streamedRun.elapsedMs,
    allBufferedMs: bufferedRuns.map((run) => run.elapsedMs),
    allStreamedMs: streamedRuns.map((run) => run.elapsedMs),
    bufferedSegments: bufferedRun.finals.length,
    streamedSegments: streamedRun.finals.length,
    transcript: streamedRun.finals.join(' '),
  }, null, 2))
} finally {
  fs.rmSync(speech.dir, { recursive: true, force: true })
}
