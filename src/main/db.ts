import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import type { TranscriptionResult } from '../shared/types'

let db: Database.Database

export function initDB(): void {
  db = new Database(path.join(app.getPath('userData'), 'nova-voice.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      language TEXT DEFAULT 'ko',
      duration REAL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      model_used TEXT DEFAULT 'whisper-large-v3-turbo-mlx'
    )
  `)

  const columns = db.pragma('table_info(transcriptions)') as Array<{ name: string }>
  if (columns.some(({ name }) => name === 'ai_mode' || name === 'ai_result')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE transcriptions_stt_only (
          id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          language TEXT DEFAULT 'ko',
          duration REAL DEFAULT 0,
          timestamp INTEGER NOT NULL,
          model_used TEXT DEFAULT 'whisper-large-v3-turbo-mlx'
        );
        INSERT INTO transcriptions_stt_only (id, text, language, duration, timestamp, model_used)
        SELECT id, text, language, duration, timestamp, model_used FROM transcriptions;
        DROP TABLE transcriptions;
        ALTER TABLE transcriptions_stt_only RENAME TO transcriptions;
      `)
    })()
    console.log('[DB] Removed legacy AI columns; preserved transcription history')
  }
  const currentColumns = new Set(
    (db.pragma('table_info(transcriptions)') as Array<{ name: string }>).map(({ name }) => name),
  )
  if (!currentColumns.has('input_mode')) {
    db.exec("ALTER TABLE transcriptions ADD COLUMN input_mode TEXT DEFAULT 'normal'")
  }
  if (!currentColumns.has('source_text')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN source_text TEXT')
  }
  if (!currentColumns.has('meta_prompt_outcome')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN meta_prompt_outcome TEXT')
  }
  if (!currentColumns.has('meta_prompt_provider')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN meta_prompt_provider TEXT')
  }
  if (!currentColumns.has('processing_duration')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN processing_duration REAL')
  }
  if (!currentColumns.has('meta_prompt_duration')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN meta_prompt_duration REAL')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_transcriptions_timestamp ON transcriptions(timestamp DESC)')
}

export function saveTranscription(result: TranscriptionResult): void {
  db.prepare(`
    INSERT INTO transcriptions (
      id, text, language, duration, timestamp, model_used,
      input_mode, source_text, meta_prompt_outcome, meta_prompt_provider,
      processing_duration, meta_prompt_duration
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.id,
    result.text,
    result.language,
    result.duration,
    result.timestamp,
    result.modelUsed,
    result.inputMode ?? 'normal',
    result.sourceText ?? null,
    result.metaPromptOutcome ?? null,
    result.metaPromptProvider ?? null,
    result.processingDuration ?? null,
    result.metaPromptDuration ?? null,
  )
}

export function getHistory(limit = 50, offset = 0): TranscriptionResult[] {
  return db.prepare(`
    SELECT id, text, language, duration, timestamp, model_used AS modelUsed,
      input_mode AS inputMode, source_text AS sourceText,
      meta_prompt_outcome AS metaPromptOutcome, meta_prompt_provider AS metaPromptProvider,
      processing_duration AS processingDuration, meta_prompt_duration AS metaPromptDuration
    FROM transcriptions
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as TranscriptionResult[]
}

export function searchHistory(query: string): TranscriptionResult[] {
  return db.prepare(`
    SELECT id, text, language, duration, timestamp, model_used AS modelUsed,
      input_mode AS inputMode, source_text AS sourceText,
      meta_prompt_outcome AS metaPromptOutcome, meta_prompt_provider AS metaPromptProvider,
      processing_duration AS processingDuration, meta_prompt_duration AS metaPromptDuration
    FROM transcriptions
    WHERE text LIKE ?
    ORDER BY timestamp DESC
    LIMIT 100
  `).all(`%${query}%`) as TranscriptionResult[]
}

export function deleteTranscription(id: string): void {
  db.prepare('DELETE FROM transcriptions WHERE id = ?').run(id)
}

export function closeDB(): void {
  if (db?.open) db.close()
}
