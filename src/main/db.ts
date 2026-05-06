import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import type { TranscriptionResult } from '../shared/types'

let db: Database.Database

export function initDB(): void {
  const dbPath = path.join(app.getPath('userData'), 'nova-voice.db')
  db = new Database(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      language TEXT DEFAULT 'auto',
      duration REAL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      model_used TEXT DEFAULT 'base',
      ai_mode TEXT DEFAULT 'direct',
      ai_result TEXT DEFAULT ''
    )
  `)

  // Migration: add ai columns if missing
  try {
    db.exec(`ALTER TABLE transcriptions ADD COLUMN ai_mode TEXT DEFAULT 'direct'`)
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE transcriptions ADD COLUMN ai_result TEXT DEFAULT ''`)
  } catch { /* column exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
}

export function saveTranscription(result: TranscriptionResult): void {
  const stmt = db.prepare(`
    INSERT INTO transcriptions (id, text, language, duration, timestamp, model_used, ai_mode, ai_result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(result.id, result.text, result.language, result.duration, result.timestamp,
    result.modelUsed, result.aiMode || 'direct', result.aiResult || '')
}

export function getHistory(limit = 50, offset = 0): TranscriptionResult[] {
  const stmt = db.prepare(`
    SELECT id, text, language, duration, timestamp,
      model_used as modelUsed, ai_mode as aiMode, ai_result as aiResult
    FROM transcriptions
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `)
  return stmt.all(limit, offset) as TranscriptionResult[]
}

export function searchHistory(query: string): TranscriptionResult[] {
  const stmt = db.prepare(`
    SELECT id, text, language, duration, timestamp,
      model_used as modelUsed, ai_mode as aiMode, ai_result as aiResult
    FROM transcriptions
    WHERE text LIKE ? OR ai_result LIKE ?
    ORDER BY timestamp DESC
    LIMIT 100
  `)
  return stmt.all(`%${query}%`, `%${query}%`) as TranscriptionResult[]
}

export function deleteTranscription(id: string): void {
  const stmt = db.prepare('DELETE FROM transcriptions WHERE id = ?')
  stmt.run(id)
}

export function closeDB(): void {
  if (db) db.close()
}
