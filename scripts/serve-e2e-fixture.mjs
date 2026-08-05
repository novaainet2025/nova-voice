import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.join(scriptDir, 'fixtures', 'injection-target.html')
const fixture = fs.readFileSync(fixturePath)
const port = Number.parseInt(process.env.NOVA_VOICE_FIXTURE_PORT || '', 10)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('NOVA_VOICE_FIXTURE_PORT must be a valid TCP port')
}

const server = http.createServer((request, response) => {
  if (request.url === '/favicon.ico') {
    response.writeHead(204, { 'Cache-Control': 'public, max-age=3600' })
    response.end()
    return
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(fixture)
    return
  }
  response.writeHead(404)
  response.end('Not found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port }))
})

const stop = () => server.close(() => process.exit(0))
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
